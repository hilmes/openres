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
  type VisitSummary,
} from "./model";
import { visitorContact } from "./visitors";

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
  localDb.function("openres_phone_digits", { deterministic: true }, (phone: unknown) => String(phone || "").replace(/\D/g, ""));
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
/** Count retained completed visits without exposing historical contacts or notes. */
export async function readVisitSummaries(records: Reservation[]): Promise<Record<string, VisitSummary>> {
  const result: Record<string, VisitSummary> = {};
  const targets = records.flatMap(record => {
    const contact = visitorContact(record);
    result[record.id] = { completedVisits: 0, lastVisit: null, matchedBy: contact?.kind || null };
    return contact ? [{ record, contact }] : [];
  });
  if (!targets.length) return result;
  const connection = await connect();
  try {
    const status = localMode() ? "json_extract(h.payload, '$.status')" : "h.payload->>'status'";
    const time = localMode() ? "json_extract(h.payload, '$.time')" : "h.payload->>'time'";
    const phone = localMode()
      ? "openres_phone_digits(json_extract(h.payload, '$.phone'))"
      : "regexp_replace(COALESCE(h.payload->>'phone', ''), '[^0-9]', '', 'g')";
    // Email and phone guests are looked up separately. One join with "email OR phone" cannot use
    // either partial index, and PostgreSQL may then compare every target with every past visit,
    // running the phone regular expression each time: seconds for a 400-party service.
    const lookups = {
      email: "lower(trim(h.email)) = t.contact",
      phone: `trim(h.email) = '' AND ${phone} = t.contact`,
    } as const;
    for (const kind of ["email", "phone"] as const) {
      const ofKind = targets.filter(({ contact }) => contact.kind === kind);
      // Bound batches keep SQLite/PostgreSQL parameter counts small for large services.
      for (let start = 0; start < ofKind.length; start += 100) {
        const batch = ofKind.slice(start, start + 100);
        const params: string[] = [];
        const values = batch.map(({ record, contact }) => {
          const offset = params.length;
          params.push(record.id, record.date, record.time, contact.value);
          return `(${Array.from({ length: 4 }, (_, i) => `$${offset + i + 1}`).join(',')})`;
        }).join(',');
        const { rows } = await connection.query(`
          WITH targets(id, visit_date, visit_time, contact) AS (VALUES ${values})
          SELECT t.id, COUNT(h.id) AS visits, MAX(h.service_date) AS last_visit
          FROM targets t LEFT JOIN openres_reservations h ON
            ${status} = 'completed' AND ${lookups[kind]} AND h.id <> t.id
            AND (h.service_date < t.visit_date OR (h.service_date = t.visit_date AND ${time} < t.visit_time))
          GROUP BY t.id`, params);
        for (const row of rows) {
          const id = String(row.id);
          result[id] = { ...result[id], completedVisits: Number(row.visits), lastVisit: row.last_visit ? String(row.last_visit) : null };
        }
      }
    }
    return result;
  } finally { connection.release(); }
}

/** Availability is an advisory read; booking mutations always recheck under the lock. */
export async function readAvailabilityInventory(date: string) {
  const connection = await connect();
  try {
    const { rows: configRows } = await connection.query('SELECT payload FROM openres_settings WHERE id = 1');
    const status = localMode() ? "json_extract(payload, '$.status')" : "payload->>'status'";
    const { rows } = await connection.query(
      `SELECT payload FROM openres_reservations WHERE (service_date = $1 AND ${status} IN ('confirmed', 'arrived', 'seated', 'waitlisted')) OR ${status} = 'seated'`,
      [date],
    );
    return { settings: configRows[0] ? decode<Settings>(configRows[0]) : structuredClone(DEFAULT_SETTINGS), reservations: rows.map(row => decode<Reservation>(row)) };
  } finally { connection.release(); }
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
): Promise<T> {
  const seated = localMode()
    ? "json_extract(payload, '$.status') = 'seated'"
    : "payload->>'status' = 'seated'";
  return transact(
    `SELECT payload FROM openres_reservations WHERE service_date = $1 OR service_date = (SELECT service_date FROM openres_reservations WHERE id = $2) OR ${seated}`,
    [date, id],
    mutate,
  );
}
/** Which stored records a retention or erasure pass loads. Never built from request text. */
export type GuestRecordSelection =
  | { kind: "expired"; before: string; limit: number }
  | { kind: "contact"; contact: { kind: "email" | "phone"; value: string } }
  | { kind: "id"; id: string };
/** Load a set of guest records under the inventory lock so removal cannot race a booking change. */
export async function withGuestRecords<T>(
  selection: GuestRecordSelection,
  mutate: (inventory: Inventory) => T,
): Promise<T> {
  const field = (name: string) => localMode() ? `json_extract(payload, '$.${name}')` : `payload->>'${name}'`;
  const kept = `${field("anonymizedAt")} IS NULL`;
  if (selection.kind === "expired")
    return transact(
      `SELECT payload FROM openres_reservations WHERE service_date < $1 AND ${field("status")} IN ('completed', 'cancelled', 'no_show') AND ${kept} ORDER BY service_date LIMIT ${Math.max(1, Math.min(1000, Math.floor(selection.limit)))}`,
      [selection.before],
      mutate,
    );
  if (selection.kind === "id")
    return transact("SELECT payload FROM openres_reservations WHERE id = $1", [selection.id], mutate);
  const phone = localMode()
    ? "openres_phone_digits(json_extract(payload, '$.phone'))"
    : "regexp_replace(COALESCE(payload->>'phone', ''), '[^0-9]', '', 'g')";
  return transact(
    selection.contact.kind === "email"
      ? `SELECT payload FROM openres_reservations WHERE lower(trim(email)) = $1 AND ${kept}`
      : `SELECT payload FROM openres_reservations WHERE trim(email) = '' AND ${phone} = $1 AND ${kept}`,
    [selection.contact.value],
    mutate,
  );
}
/** True for the first caller with this key until it expires; used to run a job at most once a day. */
export async function claimOnce(key: string, expires: number) {
  const connection = await connect();
  try {
    await connection.query("DELETE FROM openres_limits WHERE expires < $1", [Date.now()]);
    const { rows } = await connection.query(
      "INSERT INTO openres_limits (key, hits, expires) VALUES ($1, 1, $2) ON CONFLICT (key) DO NOTHING RETURNING key",
      [key, expires],
    );
    return rows.length > 0;
  } finally { connection.release(); }
}
async function transact<T>(
  select: string,
  params: unknown[],
  mutate: (inventory: Inventory) => T,
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
    const rows = (await connection.query(select, params)).rows;
    const reservations = rows.map((row) => decode<Reservation>(row));
    const previous = new Map(
      reservations.map((r) => [r.id, JSON.stringify(r)]),
    );
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

export async function consumeAuthLimit(key: string, max: number, expires: number, message = 'Too many sign-in attempts. Try again later.') {
  const connection = await connect();
  try {
    await connection.query('DELETE FROM openres_limits WHERE expires < $1', [Date.now()]);
    const { rows } = await connection.query('INSERT INTO openres_limits (key, hits, expires) VALUES ($1, 1, $2) ON CONFLICT (key) DO UPDATE SET hits = openres_limits.hits + 1 RETURNING hits', [key, expires]);
    if (Number(rows[0].hits) > max) throw new BookingError(message, 429);
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
