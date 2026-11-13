import "server-only";
import { Pool } from "pg";
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  BookingError,
  DEFAULT_SETTINGS,
  TABLES,
  venueNow,
  type Reservation,
  type Settings,
} from "./model";

export function localMode() {
  return (
    process.env.OPENRES_DEMO === "1" &&
    process.env.NODE_ENV !== "production" &&
    !process.env.VERCEL
  );
}
type Connection = {
  query: (
    query: string,
    params?: unknown[],
  ) => Promise<{ rows: Record<string, unknown>[] }>;
  release: () => void;
};
let localDb: Database.Database | undefined;
let pool: Pool | undefined;
let localQueue: Promise<void> = Promise.resolve();
function getLocalDb() {
  if (localDb) return localDb;
  const file =
    process.env.OPENRES_SQLITE_PATH ||
    join(process.cwd(), ".openres", "preview.sqlite");
  mkdirSync(dirname(file), { recursive: true });
  localDb = new Database(file);
  localDb.pragma("journal_mode = WAL");
  localDb.pragma("busy_timeout = 5000");
  localDb.exec(
    "CREATE TABLE IF NOT EXISTS openres_sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires BIGINT NOT NULL); CREATE TABLE IF NOT EXISTS openres_access_audit (id TEXT PRIMARY KEY, recorded_at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, scope TEXT NOT NULL); CREATE TABLE IF NOT EXISTS openres_settings (id INTEGER PRIMARY KEY, payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS openres_reservations (id TEXT PRIMARY KEY, service_date TEXT NOT NULL, email TEXT NOT NULL, payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS openres_limits (key TEXT PRIMARY KEY, hits INTEGER NOT NULL, expires BIGINT NOT NULL);",
  );
  if (
    !localDb.prepare("SELECT id FROM openres_settings WHERE id = 1").get()
  ) {
    const settings = {
      ...DEFAULT_SETTINGS,
      enabled: true,
      hours: DEFAULT_SETTINGS.hours.map((h) => ({ ...h, closed: false })),
    };
    localDb
      .prepare("INSERT INTO openres_settings VALUES (1, ?)")
      .run(JSON.stringify(settings));
    if (process.env.OPENRES_SEED !== "0") {
      const date = venueNow().date;
      const names = [
        "Alex Rivera",
        "Jamie Park",
        "Morgan Reyes",
        "Sam Bennett",
        "Taylor Chen",
        "Drew Martin",
      ];
      names.forEach((name, i) => {
        const status = (
          [
            "confirmed",
            "arrived",
            "seated",
            "confirmed",
            "waitlisted",
            "completed",
          ] as const
        )[i];
        const record: Reservation = {
          id: randomUUID(),
          date,
          time: `${17 + Math.floor(i / 2)}:${i % 2 ? "30" : "00"}`,
          partySize: Math.min((i % 3) + 2, TABLES[i % TABLES.length].seats),
          area: "any",
          tableId: status === "waitlisted" ? null : TABLES[i % TABLES.length].id,
          duration: 90,
          name,
          email: `preview${i}@example.com`,
          phone: "",
          notes: i === 1 ? "Celebrating a birthday." : "",
          staffNotes: "Sample guest for the local preview.",
          occasion: i === 1 ? "Birthday" : "",
          status,
          source: i === 4 ? "walk_in" : "online",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          version: 1,
          history: [],
          match: { kind: "none" },
        };
        localDb!
          .prepare("INSERT INTO openres_reservations VALUES (?, ?, ?, ?)")
          .run(record.id, date, record.email, JSON.stringify(record));
      });
    }
  }
  return localDb;
}
async function connect(): Promise<Connection> {
  if (localMode()) {
    const db = getLocalDb();
    return {
      query: async (query, params = []) => {
        const bound: unknown[] = [];
        const statement = db.prepare(
          query.replace(/\$(\d+)/g, (_, n) => {
            bound.push(params[Number(n) - 1]);
            return "?";
          }),
        );
        return {
          rows: statement.reader
            ? (statement.all(...bound) as Record<string, unknown>[])
            : (statement.run(...bound), []),
        };
      },
      release() {},
    };
  }
  if (!process.env.DATABASE_URL)
    throw new BookingError(
      "OpenRes is not connected yet. Please contact the venue.",
      503,
    );
  pool ??= new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
  const client = await pool.connect();
  return {
    query: (query, params) => client.query(query, params),
    release: () => client.release(),
  };
}
function decode<T>(row: Record<string, unknown>): T {
  return (
    typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload
  ) as T;
}
export async function readSettings(): Promise<Settings> {
  const connection = await connect();
  try {
    const { rows } = await connection.query(
      "SELECT payload FROM openres_settings WHERE id = 1",
    );
    return rows[0]
      ? decode<Settings>(rows[0])
      : structuredClone(DEFAULT_SETTINGS);
  } finally {
    connection.release();
  }
}
export async function readReservations(date?: string): Promise<Reservation[]> {
  const connection = await connect();
  try {
    const { rows } = await connection.query(
      date
        ? "SELECT payload FROM openres_reservations WHERE service_date = $1 ORDER BY service_date"
        : "SELECT payload FROM openres_reservations ORDER BY service_date DESC LIMIT 5000",
      date ? [date] : [],
    );
    return rows.map((row) => decode<Reservation>(row));
  } finally {
    connection.release();
  }
}
export async function readReservation(id: string): Promise<Reservation | null> {
  const connection = await connect();
  try {
    const { rows } = await connection.query(
      "SELECT payload FROM openres_reservations WHERE id = $1",
      [id],
    );
    return rows[0] ? decode<Reservation>(rows[0]) : null;
  } finally {
    connection.release();
  }
}
export type Inventory = {
  settings: Settings;
  reservations: Reservation[];
  audit: { actor: string; action: string; scope: string }[];
};
// One venue-wide transaction lock makes availability checks, table assignment,
// idempotency and writes atomic across every server instance.
export async function withInventory<T>(
  date: string,
  id: string,
  mutate: (inventory: Inventory) => T,
  rateKey?: string,
): Promise<T> {
  let unlock: (() => void) | undefined;
  if (localMode()) {
    const previous = localQueue;
    localQueue = new Promise((resolve) => {
      unlock = resolve;
    });
    await previous;
  }
  let connection: Connection | undefined;
  try {
    connection = await connect();
    await connection.query(localMode() ? "BEGIN IMMEDIATE" : "BEGIN");
    if (!localMode())
      await connection.query("SELECT pg_advisory_xact_lock(73632901)");
    const configRows = (
      await connection.query(
        "SELECT payload FROM openres_settings WHERE id = 1",
      )
    ).rows;
    const settings = configRows[0]
      ? decode<Settings>(configRows[0])
      : structuredClone(DEFAULT_SETTINGS);
    const seated = localMode()
      ? "json_extract(payload, '$.status') = 'seated'"
      : "payload->>'status' = 'seated'";
    const rows = (
      await connection.query(
        `SELECT payload FROM openres_reservations WHERE service_date = $1 OR service_date = (SELECT service_date FROM openres_reservations WHERE id = $2) OR ${seated}`,
        [date, id],
      )
    ).rows;
    const reservations = rows.map((row) => decode<Reservation>(row));
    const previous = new Map(
      reservations.map((r) => [r.id, JSON.stringify(r)]),
    );
    if (rateKey && !previous.has(id)) {
      const now = Date.now();
      await connection.query(
        "DELETE FROM openres_limits WHERE expires < $1",
        [now],
      );
      const limits = (
        await connection.query(
          "SELECT hits FROM openres_limits WHERE key = $1",
          [rateKey],
        )
      ).rows;
      const hits = Number(limits[0]?.hits || 0);
      if (hits >= 8)
        throw new BookingError(
          "Too many requests. Please try again in an hour or contact the venue.",
          429,
        );
      await connection.query(
        "INSERT INTO openres_limits (key, hits, expires) VALUES ($1, 1, $2) ON CONFLICT (key) DO UPDATE SET hits = openres_limits.hits + 1",
        [rateKey, now + 3600000],
      );
    }
    const inventory: Inventory = { settings, reservations, audit: [] };
    const result = mutate(inventory);
    if (
      JSON.stringify(inventory.settings) !== JSON.stringify(settings) ||
      !configRows.length
    ) {
      await connection.query(
        "INSERT INTO openres_settings (id, payload) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET payload = excluded.payload",
        [JSON.stringify(inventory.settings)],
      );
    }
    for (const record of inventory.reservations) {
      if (previous.get(record.id) === JSON.stringify(record)) continue;
      await connection.query(
        "INSERT INTO openres_reservations (id, service_date, email, payload) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO UPDATE SET service_date = excluded.service_date, email = excluded.email, payload = excluded.payload",
        [record.id, record.date, record.email, JSON.stringify(record)],
      );
    }
    for (const entry of inventory.audit)
      await connection.query(
        "INSERT INTO openres_access_audit (id, recorded_at, actor, action, scope) VALUES ($1, $2, $3, $4, $5)",
        [
          randomUUID(),
          new Date().toISOString(),
          entry.actor,
          entry.action,
          entry.scope,
        ],
      );
    await connection.query("COMMIT");
    return result;
  } catch (error) {
    if (connection) await connection.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    connection?.release();
    unlock?.();
  }
}

/** Access audit stores actor, operation and date/count only, never exported guest fields. */
export async function recordAccessAudit(
  actor: string,
  action: string,
  scope: string,
) {
  const connection = await connect();
  try {
    await connection.query(
      "INSERT INTO openres_access_audit (id, recorded_at, actor, action, scope) VALUES ($1, $2, $3, $4, $5)",
      [randomUUID(), new Date().toISOString(), actor, action, scope],
    );
  } finally {
    connection.release();
  }
}

export async function consumeAuthLimit(key: string, max: number, expires: number) {
  const connection = await connect();
  try {
    await connection.query('DELETE FROM openres_limits WHERE expires < $1', [Date.now()]);
    const { rows } = await connection.query('INSERT INTO openres_limits (key, hits, expires) VALUES ($1, 1, $2) ON CONFLICT (key) DO UPDATE SET hits = openres_limits.hits + 1 RETURNING hits', [key, expires]);
    if (Number(rows[0].hits) > max) throw new BookingError('Too many sign-in attempts. Try again later.', 429);
  } finally { connection.release(); }
}
export async function saveSession(tokenHash: string, identity: string, expires: number) {
  const connection = await connect();
  try {
    await connection.query('DELETE FROM openres_sessions WHERE expires < $1', [Date.now()]);
    await connection.query('INSERT INTO openres_sessions (token_hash, user_id, expires) VALUES ($1, $2, $3)', [tokenHash, identity, expires]);
  } finally { connection.release(); }
}
export async function sessionIdentity(tokenHash: string) {
  const connection = await connect();
  try {
    const { rows } = await connection.query('SELECT user_id FROM openres_sessions WHERE token_hash = $1 AND expires > $2', [tokenHash, Date.now()]);
    return rows[0] ? String(rows[0].user_id) : null;
  } finally { connection.release(); }
}
export async function deleteSession(tokenHash: string) {
  const connection = await connect();
  try { await connection.query('DELETE FROM openres_sessions WHERE token_hash = $1', [tokenHash]); }
  finally { connection.release(); }
}
