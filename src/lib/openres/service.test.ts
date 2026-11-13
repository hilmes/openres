// @vitest-environment node
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
vi.mock("server-only", () => ({}));
import {
  availableTables,
  availability,
  bookingSchema,
  DEFAULT_SETTINGS,
  guestReservation,
  TABLES,
  venueNow,
  type Settings,
} from "./model";
import {
  createReservation,
  managementToken,
  updateReservation,
  updateSettings,
  verifyManagementToken,
  visitHistory,
} from "./service";
import { localMode, readReservation, readSettings } from "./store";
import { bookingFixtures } from "./fixtures";

const folder = mkdtempSync(join(tmpdir(), "openres-test-"));
const file = join(folder, "reservations.sqlite");
const now = new Date("2026-11-12T17:00:00Z"); // Noon in New York
const date = "2026-11-13";
let db: Database.Database;
function input(patch = {}) {
  return {
    id: randomUUID(),
    requestKey: randomUUID(),
    date,
    time: "18:00",
    partySize: 2,
    area: "any",
    name: "Test Guest",
    email: `${randomUUID()}@example.com`,
    phone: "+12125550100",
    ...patch,
  };
}
function config(): Settings {
  return {
    ...structuredClone(DEFAULT_SETTINGS),
    enabled: true,
    disabledTables: TABLES.filter((t) => t.id !== "11").map((t) => t.id),
  };
}
beforeAll(async () => {
  vi.stubEnv("OPENRES_DEMO", "1");
  vi.stubEnv("OPENRES_SQLITE_PATH", file);
  vi.stubEnv("OPENRES_SEED", "0");
  vi.stubEnv("VERCEL", "");
  await readSettings();
  db = new Database(file);
});
beforeEach(() => {
  db.exec("DELETE FROM openres_reservations; DELETE FROM openres_limits;");
  db.prepare("UPDATE openres_settings SET payload = ? WHERE id = 1").run(
    JSON.stringify(config()),
  );
});
afterAll(() => {
  db.close();
  vi.unstubAllEnvs();
  rmSync(folder, { recursive: true, force: true });
});

describe("OpenRes inventory and persistence", () => {
  it("allows only one concurrent reservation for the same last table", async () => {
    const results = await Promise.allSettled([
      createReservation(input(), undefined, undefined, now),
      createReservation(input(), undefined, undefined, now),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM openres_reservations").get(),
    ).toEqual({ count: 1 });
  });
  it("persists a booking and returns the same receipt for an idempotent retry", async () => {
    const request = input();
    const first = await createReservation(request, undefined, undefined, now);
    const second = await createReservation(request, undefined, undefined, now);
    expect(second.created).toBe(false);
    expect(second.token).toBe(first.token);
    expect(await readReservation(first.reservation.id)).toEqual(
      first.reservation,
    );
    await expect(
      createReservation(
        { ...request, email: "intruder@example.com" },
        undefined,
        undefined,
        now,
      ),
    ).rejects.toThrow("new booking request");
  });
  it("rejects a conflicting change even when the update omits the service date", async () => {
    const first = await createReservation(input(), undefined, undefined, now);
    await createReservation(
      input({ time: "19:30" }),
      undefined,
      undefined,
      now,
    );
    await expect(
      updateReservation(
        first.reservation.id,
        { version: 1, time: "19:00" },
        undefined,
        now,
      ),
    ).rejects.toThrow("No suitable table");
    expect((await readReservation(first.reservation.id))?.time).toBe("18:00");
  });
  it("keeps the original booking when rescheduling to another sold-out day", async () => {
    const first = await createReservation(input(), undefined, undefined, now);
    await createReservation(
      input({ date: "2026-11-14" }),
      undefined,
      undefined,
      now,
    );
    await expect(
      updateReservation(
        first.reservation.id,
        { version: 1, date: "2026-11-14" },
        undefined,
        now,
      ),
    ).rejects.toThrow("No suitable table");
    expect((await readReservation(first.reservation.id))?.date).toBe(date);
  });
  it("allows adjacent bookings and releases inventory on cancellation", async () => {
    const first = await createReservation(input(), undefined, undefined, now);
    await createReservation(
      input({ time: "19:30" }),
      undefined,
      undefined,
      now,
    );
    await updateReservation(
      first.reservation.id,
      { version: 1, status: "cancelled" },
      undefined,
      now,
    );
    const replacement = await createReservation(
      input(),
      undefined,
      undefined,
      now,
    );
    expect(replacement.reservation.tableId).toBe("11");
  });
  it("rejects stale edits without overwriting the newer version", async () => {
    const first = await createReservation(input(), undefined, undefined, now);
    await updateReservation(
      first.reservation.id,
      { version: 1, notes: "Updated" },
      undefined,
      now,
    );
    await expect(
      updateReservation(
        first.reservation.id,
        { version: 1, status: "cancelled" },
        undefined,
        now,
      ),
    ).rejects.toThrow("changed");
    expect((await readReservation(first.reservation.id))?.notes).toBe(
      "Updated",
    );
  });
  it("does not reserve inventory for waitlisted parties; promotion rechecks it", async () => {
    const waiting = await createReservation(
      input({ waitlist: true }),
      undefined,
      undefined,
      now,
    );
    expect(waiting.reservation.tableId).toBeNull();
    const booked = await createReservation(input(), undefined, undefined, now);
    await expect(
      updateReservation(
        waiting.reservation.id,
        { version: 1, status: "confirmed" },
        "staff",
        now,
      ),
    ).rejects.toThrow("No suitable table");
    await updateReservation(
      booked.reservation.id,
      { version: 1, status: "cancelled" },
      "staff",
      now,
    );
    expect(
      (
        await updateReservation(
          waiting.reservation.id,
          { version: 1, status: "confirmed" },
          "staff",
          now,
        )
      ).tableId,
    ).toBe("11");
  });
  it("prevents late seating from colliding with the next party", async () => {
    const first = await createReservation(input(), undefined, undefined, now);
    await createReservation(
      input({ time: "19:30" }),
      undefined,
      undefined,
      now,
    );
    await expect(
      updateReservation(
        first.reservation.id,
        { version: 1, status: "seated" },
        "staff",
        new Date("2026-11-13T23:30:00Z"),
      ),
    ).rejects.toThrow("No suitable table");
  });
  it("supports staff walk-ins without invented contact details", async () => {
    const result = await createReservation(
      input({
        date: "2026-11-12",
        time: "14:00",
        email: "",
        phone: "",
        source: "walk_in",
      }),
      "staff",
      undefined,
      new Date("2026-11-12T19:00:00Z"),
    );
    expect(result.reservation.status).toBe("seated");
    await expect(
      createReservation(input({ source: "walk_in" }), "staff", undefined, now),
    ).rejects.toThrow("Walk-ins must be seated now");
  });
  it("keeps overstay tables unavailable until staff finish the visit", () => {
    const seated = {
      ...input(),
      tableId: "11",
      duration: 90,
      status: "seated",
      date: "2026-11-12",
      time: "14:00",
    };
    const candidates = availableTables(
      { date: seated.date, time: "16:00", partySize: 2, area: "any" },
      [seated as never],
      config(),
      undefined,
      new Date("2026-11-12T21:05:00Z"),
    );
    expect(candidates).toHaveLength(0);
  });
  it("enforces disabled intake, closed dates, party limits, and lead time", async () => {
    await updateSettings({ ...config(), enabled: false });
    await expect(
      createReservation(input(), undefined, undefined, now),
    ).rejects.toThrow("not open");
    expect(bookingSchema.safeParse(input({ partySize: 9 })).success).toBe(
      false,
    );
    const mondayClosed = config();
    mondayClosed.hours[1].closed = true;
    expect(
      availability("2026-11-16", 2, "any", [], mondayClosed, now),
    ).toHaveLength(0);
    expect(
      availability(
        date,
        2,
        "any",
        [],
        { ...config(), closedDates: [date] },
        now,
      ),
    ).toHaveLength(0);
    expect(
      availability(
        "2026-11-12",
        2,
        "any",
        [],
        config(),
        new Date("2026-11-12T19:00:00Z"),
      )[0].time,
    ).toBe("14:30");
  });
  it("rate limits persisted requests and rolls back rejected writes", async () => {
    for (let i = 0; i < 8; i++)
      await createReservation(
        input({ waitlist: true }),
        undefined,
        "test-rate-key",
        now,
      );
    await expect(
      createReservation(
        input({ waitlist: true }),
        undefined,
        "test-rate-key",
        now,
      ),
    ).rejects.toMatchObject({ status: 429 });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM openres_reservations").get(),
    ).toEqual({ count: 8 });
  });
});
describe("match-first bookings", () => {
  const fixture = {
    id: "fixture-1",
    date,
    time: "18:00",
    home: "Arsenal",
    away: "Chelsea",
    competition: "PL",
  };
  it.each([
    { kind: "none" },
    { kind: "other", request: "Mexico vs USA" },
    { kind: "fixture", fixture },
  ])("preserves match preference %j for guests and the host", async (match) => {
    const result = await createReservation(
      input({ match }),
      undefined,
      undefined,
      now,
    );
    expect((await readReservation(result.reservation.id))?.match).toEqual(
      match,
    );
    expect(guestReservation(result.reservation).match).toEqual(match);
  });
  it("rejects an empty other request and a fixture booked on the wrong date", async () => {
    expect(
      bookingSchema.safeParse(input({ match: { kind: "other", request: " " } }))
        .success,
    ).toBe(false);
    await expect(
      createReservation(
        input({
          match: {
            kind: "fixture",
            fixture: { ...fixture, date: "2026-11-14" },
          },
        }),
        undefined,
        undefined,
        now,
      ),
    ).rejects.toThrow("fixture date");
  });
  it("filters past fixtures from the operator catalog", () => {
    expect(
      bookingFixtures(
        [
          { id: 'past', date: '2026-11-12', time: '11:00', home: 'A', away: 'B', competition: 'Example' },
          { id: 'upcoming', date: '2026-11-12', time: '19:30', home: 'C', away: 'D', competition: 'Example' },
        ],
        now,
      ),
    ).toEqual([
      expect.objectContaining({ date: "2026-11-12", time: "19:30", home: "C" }),
    ]);
  });
});
describe("privacy and authorization boundaries", () => {
  it('preserves guest notes and preferences when staff changes only status', async () => {
    const first = await createReservation(input({notes:'Window requested',area:'tables',match:{kind:'other',request:'Example match'}}), undefined, undefined, now);
    const next = await updateReservation(first.reservation.id,{version:1,status:'arrived'},'host',now);
    expect(next).toMatchObject({notes:'Window requested',area:'tables',match:{kind:'other',request:'Example match'}});
    expect(next.history.at(-1)?.fields).toEqual(['status']);
  });
  it("accepts a guest booking without collecting a phone or occasion", async () => {
    const request = input({ phone: undefined });
    const { reservation } = await createReservation(
      request,
      undefined,
      undefined,
      now,
    );
    expect((await readReservation(reservation.id))?.phone).toBe("");
    expect(reservation.occasion).toBe("");
  });
  it("projects venue history without exposing contacts, notes, fixture requests or audit actors", async () => {
    const { reservation } = await createReservation(
      input({ notes: "Private seating note" }),
      undefined,
      undefined,
      now,
    );
    const [visit, again, different] = visitHistory([
      reservation,
      { ...reservation, id: randomUUID() },
      { ...reservation, email: "another@example.com" },
    ]);
    expect(Object.keys(visit).sort()).toEqual([
      "date",
      "guestKey",
      "id",
      "name",
      "partySize",
      "status",
      "time",
    ]);
    expect(visit.guestKey).toMatch(/^[a-f0-9]{64}$/);
    expect(again.guestKey).toBe(visit.guestKey);
    expect(different.guestKey).not.toBe(visit.guestKey);
    expect(JSON.stringify(visit)).not.toContain(reservation.email);
    expect(JSON.stringify(visit)).not.toContain(reservation.notes);
  });
  it("does not merge guests by name when they have no contact details", async () => {
    const { reservation } = await createReservation(
      input({ email: "", phone: "" }),
      "staff",
      undefined,
      now,
    );
    const [first, second] = visitHistory([
      reservation,
      { ...reservation, id: randomUUID() },
    ]);
    expect(first.guestKey).not.toBe(second.guestKey);
  });
  it("uses unguessable, per-reservation management tokens", () => {
    const id = randomUUID();
    const token = managementToken(id);
    expect(verifyManagementToken(id, token)).toBe(true);
    expect(verifyManagementToken(randomUUID(), token)).toBe(false);
    expect(verifyManagementToken(id, `${token}tampered`)).toBe(false);
  });
  it("rejects guest attempts to seat parties or write private staff notes", async () => {
    const { reservation } = await createReservation(
      input(),
      undefined,
      undefined,
      now,
    );
    for (const patch of [
      { status: "seated" },
      { staffNotes: "VIP" },
      { tableId: "11" },
    ])
      await expect(
        updateReservation(
          reservation.id,
          { version: 1, ...patch },
          undefined,
          now,
        ),
      ).rejects.toMatchObject({ status: 403 });
    expect(guestReservation(reservation)).not.toHaveProperty("staffNotes");
    expect(guestReservation(reservation)).not.toHaveProperty("history");
  });
  it("cannot enable the local auth bypass in production or on Vercel", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(localMode()).toBe(false);
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("VERCEL", "1");
    expect(localMode()).toBe(false);
    vi.stubEnv("VERCEL", "");
  });
  it("uses New York dates across UTC midnight and daylight saving", () => {
    expect(venueNow(new Date("2026-11-13T02:00:00Z"))).toEqual({
      date: "2026-11-12",
      minutes: 1260,
    });
    expect(venueNow(new Date("2026-07-01T02:00:00Z"))).toEqual({
      date: "2026-06-30",
      minutes: 1320,
    });
  });
});

describe("tablet seating and data provenance", () => {
  it("honors a staff-selected table and rejects assigning an occupied table", async () => {
    const first = await createReservation(
      input({ tableId: "11" }),
      "staff-a",
      undefined,
      now,
    );
    expect(first.reservation.tableId).toBe("11");
    await expect(
      createReservation(input({ tableId: "12" }), "staff-a", undefined, now),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      createReservation(input({ tableId: "11" }), "staff-b", undefined, now),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("moves a seated party atomically and records the actor, version and seating state", async () => {
    const settings = {
      ...config(),
      disabledTables: TABLES.filter((t) => !["11", "12"].includes(t.id)).map(
        (t) => t.id,
      ),
    };
    await updateSettings(settings);
    const checkIn = new Date("2026-11-13T23:00:00Z");
    const first = await createReservation(
      input({ tableId: "11", source: "walk_in" }),
      "host-a",
      undefined,
      checkIn,
    );
    const moved = await updateReservation(
      first.reservation.id,
      {
        version: 1,
        tableId: "12",
        staffNotes: "Private detail never copied to audit",
      },
      "host-b",
      new Date("2026-11-13T23:15:00Z"),
    );
    expect(moved).toMatchObject({
      status: "seated",
      tableId: "12",
      version: 2,
    });
    expect(moved.history.at(-1)).toMatchObject({
      actor: "host-b",
      action: "Moved seated party",
      version: 2,
      state: { tableId: "12", status: "seated" },
    });
    expect(JSON.stringify(moved.history)).not.toContain("Private detail");
    const second = await createReservation(
      input({ tableId: "11", time: "18:15", source: "walk_in" }),
      "host-a",
      undefined,
      new Date("2026-11-13T23:15:00Z"),
    );
    await expect(
      updateReservation(
        moved.id,
        { version: 2, tableId: "11" },
        "host-b",
        new Date("2026-11-13T23:15:00Z"),
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect((await readReservation(second.reservation.id))?.tableId).toBe("11");
    expect((await readReservation(moved.id))?.tableId).toBe("12");
  });
  it("does not trust client-supplied provenance or an altered calendar attestation", async () => {
    const { attestFixture } = await import("./service");
    const fixture = attestFixture(
      {
        id: "source-1",
        date,
        time: "18:00",
        home: "Arsenal",
        away: "Chelsea",
        competition: "PL",
      },
      now,
    );
    const first = await createReservation(
      input({
        match: { kind: "fixture", fixture },
        provenance: { createdBy: "staff", actor: "forged" },
      }),
      undefined,
      undefined,
      now,
    );
    expect(first.reservation.provenance).toMatchObject({
      createdBy: "guest",
      actor: "Guest",
      environment: "local_preview",
      match: {
        source: "sample_fixture",
        sourceId: "source-1",
        capturedAt: now.toISOString(),
      },
    });
    const second = await createReservation(
      input({
        time: "20:00",
        match: {
          kind: "fixture",
          fixture: { ...fixture, away: "Forged team" },
        },
      }),
      undefined,
      undefined,
      now,
    );
    expect(second.reservation.provenance?.match.source).toBe(
      "supplied_fixture",
    );
    expect(guestReservation(first.reservation)).not.toHaveProperty(
      "provenance",
    );
    expect(guestReservation(first.reservation)).not.toHaveProperty("history");
  });
  it("keeps changed match provenance and the original creator independently", async () => {
    const created = await createReservation(input(), "host-a", undefined, now);
    const updated = await updateReservation(
      created.reservation.id,
      { version: 1, match: { kind: "other", request: "Mexico vs USA" } },
      undefined,
      now,
    );
    expect(updated.provenance).toMatchObject({
      createdBy: "staff",
      actor: "host-a",
      match: { source: "match_request" },
    });
    expect(updated.history.at(-1)).toMatchObject({
      actor: "Guest",
      version: 2,
      fields: ["match"],
      matchSource: "match_request",
    });
  });
});

it("checks walk-in availability at actual seating time, not a future rounded slot", async () => {
  await createReservation(input({ time: "17:15" }), "host", undefined, now);
  await expect(
    createReservation(
      input({ time: "18:45", source: "walk_in", tableId: "11" }),
      "host",
      undefined,
      new Date("2026-11-13T23:35:00Z"),
    ),
  ).rejects.toMatchObject({ status: 409 });
});
it("records manager settings provenance in the same transaction", async () => {
  const saved = await updateSettings(
    { ...config(), duration: 120 },
    "manager-17",
  );
  const event = db
    .prepare(
      "SELECT actor, scope FROM openres_access_audit WHERE action = 'settings_changed' ORDER BY rowid DESC LIMIT 1",
    )
    .get() as { actor: string; scope: string };
  expect(event.actor).toBe("manager-17");
  expect(JSON.parse(event.scope)).toMatchObject({
    version: saved.version,
    fields: ["duration"],
    settings: { duration: 120 },
  });
});

describe("booking retry security", () => {
  it("requires a private retry key even when the caller knows the ID and contacts", async () => {
    const request = input();
    const first = await createReservation(request, undefined, undefined, now);
    await expect(createReservation({ ...request, requestKey: randomUUID() }, undefined, undefined, now)).rejects.toMatchObject({ status: 409 });
    const withoutKey = { ...request, requestKey: undefined };
    await expect(createReservation(withoutKey, undefined, undefined, now)).rejects.toThrow();
    const retry = await createReservation(request, undefined, undefined, now);
    expect(retry.token).toBe(first.token);
    expect(JSON.stringify(first.reservation)).not.toContain(request.requestKey);
    expect(guestReservation(first.reservation)).not.toHaveProperty('requestKeyHash');
  });
  it("requires the existing management link for legacy records without a retry hash", async () => {
    const request = input();
    const first = await createReservation(request, undefined, undefined, now);
    const legacy = { ...first.reservation, requestKeyHash: undefined };
    db.prepare('UPDATE openres_reservations SET payload = ? WHERE id = ?').run(JSON.stringify(legacy), request.id);
    await expect(createReservation(request, undefined, undefined, now)).rejects.toMatchObject({ status: 409 });
    expect(verifyManagementToken(request.id, first.token)).toBe(true);
  });
  it("counts rejected booking attempts without persisting failed reservations", async () => {
    db.prepare('UPDATE openres_settings SET payload = ? WHERE id = 1').run(JSON.stringify({ ...config(), closedDates: [date] }));
    for (let i = 0; i < 8; i++) {
      await expect(createReservation(input(), undefined, 'rejected-attempts', now)).rejects.toMatchObject({ status: 400 });
    }
    await expect(createReservation(input(), undefined, 'rejected-attempts', now)).rejects.toMatchObject({ status: 429 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM openres_reservations').get()).toEqual({ count: 0 });
  });
});
