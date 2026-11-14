// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

vi.mock("server-only", () => ({}));
import { DEFAULT_SETTINGS, FORMER_GUEST, type Reservation, type Settings } from "./model";
import { anonymized, createReservation, eraseGuest, purgeExpired, purgeIfDue, visitHistory } from "./service";
import { readReservation, readSettings, readVisitSummaries } from "./store";

const folder = mkdtempSync(join(tmpdir(), "openres-retention-test-"));
const file = join(folder, "reservations.sqlite");
const now = new Date("2026-11-12T17:00:00Z"); // Noon in New York on 2026-11-12
let db: Database.Database;

function settings(patch: Partial<Settings> = {}) {
  db.prepare("UPDATE openres_settings SET payload = ? WHERE id = 1").run(JSON.stringify({ ...structuredClone(DEFAULT_SETTINGS), enabled: true, ...patch }));
}
function seed(patch: Partial<Reservation> = {}): Reservation {
  const record: Reservation = {
    id: randomUUID(), requestKeyHash: "a".repeat(64), date: "2026-09-01", time: "18:00", partySize: 2, area: "any", tableId: "11", duration: 90,
    name: "Dana Example", email: "dana@example.com", phone: "+1 (212) 555-0100", notes: "Allergy: shellfish", staffNotes: "Regular", occasion: "Birthday",
    status: "completed", source: "online", createdAt: "2026-08-20T12:00:00.000Z", updatedAt: "2026-09-01T23:00:00.000Z", version: 3,
    history: [{ at: "2026-08-20T12:00:00.000Z", actor: "Guest", action: "Created reservation" }], match: { kind: "other", request: "Dana's cousin's club final" },
    ...patch,
  };
  db.prepare("INSERT INTO openres_reservations VALUES (?, ?, ?, ?)").run(record.id, record.date, record.email, JSON.stringify(record));
  return record;
}
const stored = (id: string) => db.prepare("SELECT service_date, email, payload FROM openres_reservations WHERE id = ?").get(id) as { service_date: string; email: string; payload: string };
const audit = () => db.prepare("SELECT actor, action, scope FROM openres_access_audit ORDER BY recorded_at").all() as { actor: string; action: string; scope: string }[];

beforeAll(async () => {
  vi.stubEnv("OPENRES_DEMO", "1");
  vi.stubEnv("OPENRES_SQLITE_PATH", file);
  vi.stubEnv("OPENRES_SEED", "0");
  vi.stubEnv("VERCEL", "");
  await readSettings();
  db = new Database(file);
});
beforeEach(() => {
  db.exec("DELETE FROM openres_reservations; DELETE FROM openres_limits; DELETE FROM openres_access_audit;");
  settings();
});
afterAll(() => {
  db.close();
  vi.unstubAllEnvs();
  rmSync(folder, { recursive: true, force: true });
});

describe("retention period", () => {
  it("does nothing until a manager sets a period", async () => {
    const old = seed();
    expect(await purgeExpired("System", now)).toEqual({ removed: 0, more: false, retentionDays: null });
    expect((await readReservation(old.id))?.email).toBe("dana@example.com");
    expect(audit()).toEqual([]);
  });

  it("removes guest details from finished visits past the period and keeps the visit", async () => {
    settings({ retentionDays: 30 });
    const old = seed();
    const cancelled = seed({ status: "cancelled", email: "other@example.com", match: { kind: "fixture", fixture: { id: "f1", date: "2026-09-01", time: "15:00", home: "A", away: "B", competition: "Cup" } } });
    expect(await purgeExpired("System", now)).toEqual({ removed: 2, more: false, retentionDays: 30 });

    const row = stored(old.id);
    expect(row.email).toBe("");
    expect(row.payload).not.toMatch(/dana|Dana|555|shellfish|Regular|Birthday|cousin/);
    const record = JSON.parse(row.payload) as Reservation;
    expect(record).toMatchObject({ name: FORMER_GUEST, email: "", phone: "", notes: "", staffNotes: "", occasion: "", match: { kind: "none" }, date: "2026-09-01", time: "18:00", partySize: 2, tableId: "11", status: "completed", source: "online", version: 4 });
    expect(record.requestKeyHash).toBeUndefined();
    expect(record.anonymizedAt).toBe(now.toISOString());
    expect(record.history.at(-1)).toMatchObject({ actor: "System", action: "Guest details removed", fields: ["anonymized"] });
    // A catalog fixture is not personal and stays for reporting.
    expect((await readReservation(cancelled.id))?.match.kind).toBe("fixture");
    // The audit says how many and the cutoff, never who.
    expect(audit()).toEqual([{ actor: "System", action: "retention_purge", scope: "before=2026-10-13; records=2" }]);
  });

  it("keeps visits inside the period, the cutoff day itself, and every booking still in progress", async () => {
    settings({ retentionDays: 30 });
    const recent = seed({ date: "2026-11-01" });
    const onCutoff = seed({ date: "2026-10-13", email: "cutoff@example.com" });
    const dayBefore = seed({ date: "2026-10-12", email: "before@example.com" });
    const active = (["confirmed", "arrived", "seated", "waitlisted"] as const).map((status) => seed({ status, email: `${status}@example.com` }));
    expect((await purgeExpired("System", now)).removed).toBe(1);
    expect((await readReservation(dayBefore.id))?.name).toBe(FORMER_GUEST);
    for (const kept of [recent, onCutoff, ...active]) expect((await readReservation(kept.id))?.email).toBe(kept.email);
  });

  it("is idempotent and reports when more remain than one pass handles", async () => {
    settings({ retentionDays: 30 });
    for (let i = 0; i < 501; i++) seed({ email: `guest${i}@example.com` });
    expect(await purgeExpired("System", now)).toMatchObject({ removed: 500, more: true });
    expect(await purgeExpired("System", now)).toMatchObject({ removed: 1, more: false });
    expect(await purgeExpired("System", now)).toMatchObject({ removed: 0, more: false });
    expect(db.prepare("SELECT COUNT(*) AS n FROM openres_reservations WHERE email <> ''").get()).toEqual({ n: 0 });
  });

  it("runs at most once per venue day across desks", async () => {
    settings({ retentionDays: 30 });
    const first = seed();
    await purgeIfDue(now);
    expect((await readReservation(first.id))?.name).toBe(FORMER_GUEST);
    const later = seed({ email: "later@example.com" });
    await purgeIfDue(new Date(now.getTime() + 3600000));
    expect((await readReservation(later.id))?.email).toBe("later@example.com");
    await purgeIfDue(new Date(now.getTime() + 86400000));
    expect((await readReservation(later.id))?.name).toBe(FORMER_GUEST);
  });

  it("stops counting removed visits toward a returning guest and cannot be replayed into a receipt", async () => {
    settings({ retentionDays: 30 });
    const old = seed({ requestKeyHash: undefined });
    await purgeExpired("System", now);
    const { reservation } = await createReservation({ id: randomUUID(), requestKey: randomUUID(), date: "2026-11-13", time: "18:00", partySize: 2, area: "any", name: "Dana Example", email: "dana@example.com" }, undefined, undefined, now);
    expect((await readVisitSummaries([reservation]))[reservation.id]).toMatchObject({ completedVisits: 0, lastVisit: null });
    const removed = (await readReservation(old.id))!;
    const [a, b] = visitHistory([removed, { ...removed, id: randomUUID() }]);
    expect(a.guestKey).not.toBe(b.guestKey);
    await expect(createReservation({ id: old.id, requestKey: randomUUID(), date: "2026-11-13", time: "18:00", partySize: 2, area: "any", name: "Dana Example", email: "dana@example.com" }, undefined, undefined, now)).rejects.toMatchObject({ status: 409 });
  });
});

describe("erasing one guest on request", () => {
  it("removes every retained visit sharing the contact, whatever its age, and no one else's", async () => {
    const visits = [seed({ date: "2026-11-01" }), seed({ date: "2025-03-01", email: " Dana@Example.com " }), seed({ status: "no_show" })];
    const other = seed({ email: "someone.else@example.com", name: "Dana Example" });
    expect(await eraseGuest(visits[0].id, "manager-1", now)).toEqual({ erased: 3 });
    for (const visit of visits) expect(stored(visit.id).payload).not.toMatch(/dana|Dana|555/i);
    expect((await readReservation(other.id))?.email).toBe("someone.else@example.com");
    expect(audit()).toEqual([{ actor: "manager-1", action: "guest_erasure", scope: "records=3; matched=email" }]);
    await expect(eraseGuest(visits[0].id, "manager-1", now)).rejects.toMatchObject({ status: 409 });
  });

  it("matches a phone-only guest by digits and a guest with no contact by the record alone", async () => {
    const phone = [seed({ email: "", phone: "212-555-0100" }), seed({ email: "", phone: "(212) 555 0100" })];
    const withEmail = seed({ phone: "2125550100", email: "has.email@example.com" });
    expect(await eraseGuest(phone[0].id, "manager-1", now)).toEqual({ erased: 2 });
    expect((await readReservation(withEmail.id))?.phone).toBe("2125550100");
    const walkIns = [seed({ email: "", phone: "", name: "Walk In" }), seed({ email: "", phone: "", name: "Walk In" })];
    expect(await eraseGuest(walkIns[0].id, "manager-1", now)).toEqual({ erased: 1 });
    expect((await readReservation(walkIns[1].id))?.name).toBe("Walk In");
  });

  it("refuses while the guest has a booking in progress, and changes nothing", async () => {
    const past = seed();
    const upcoming = seed({ date: "2026-11-20", status: "confirmed" });
    await expect(eraseGuest(past.id, "manager-1", now)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("in progress") });
    expect((await readReservation(past.id))?.email).toBe("dana@example.com");
    expect((await readReservation(upcoming.id))?.email).toBe("dana@example.com");
    expect(audit()).toEqual([]);
    await expect(eraseGuest(randomUUID(), "manager-1", now)).rejects.toMatchObject({ status: 404 });
  });
});

it("anonymizing is a pure projection that leaves the original untouched", () => {
  const record = seed();
  const next = anonymized(record, "System", now);
  expect(record.email).toBe("dana@example.com");
  expect(JSON.stringify(next)).not.toMatch(/dana@example|555|shellfish/);
});
