// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

vi.mock("server-only", () => ({}));
import { DEFAULT_SETTINGS, editedMatchPreference, guestReservation, matchLabel, matchPreferenceSchema, supporterTally, type MatchPreference } from "./model";
import { anonymized, createReservation, supporterContacts, supporterTeams, updateReservation, visitHistory } from "./service";
import { readReservation, readReservations, readSettings } from "./store";

const folder = mkdtempSync(join(tmpdir(), "openres-supporters-test-"));
const file = join(folder, "reservations.sqlite");
const now = new Date("2026-11-12T17:00:00Z"); // Noon in New York; the visits below are the next day
const later = (minutes: number) => new Date(now.getTime() + minutes * 60000);
const date = "2026-11-13";
const fixture = { id: "fixture-1", date, time: "15:00", home: "Arsenal", away: "Chelsea", competition: "Cup" };
const withSide = (side?: "home" | "away"): MatchPreference => ({ kind: "fixture", fixture, ...(side ? { side } : {}) });
let db: Database.Database;

const input = (patch = {}) => ({ id: randomUUID(), requestKey: randomUUID(), date, time: "15:00", partySize: 2, area: "any", name: "Test Guest", email: `${randomUUID()}@example.com`, phone: "", match: withSide("home"), ...patch });
const book = async (patch = {}, actor?: string, at = now) => (await createReservation(input(patch), actor, undefined, at)).reservation;
const guestEdit = async (id: string, patch: Record<string, unknown>, at = later(1)) => updateReservation(id, { version: (await readReservation(id))!.version, ...patch }, undefined, at);

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
  db.prepare("UPDATE openres_settings SET payload = ? WHERE id = 1").run(JSON.stringify({ ...structuredClone(DEFAULT_SETTINGS), enabled: true }));
});
afterAll(() => {
  db.close();
  vi.unstubAllEnvs();
  rmSync(folder, { recursive: true, force: true });
});

describe("the side a party is with", () => {
  it("is accepted only on a fixture, shows in the label, and counts toward that side", async () => {
    expect(matchPreferenceSchema.parse(withSide("away"))).toMatchObject({ side: "away" });
    expect(() => matchPreferenceSchema.parse({ kind: "fixture", fixture, side: "both" })).toThrow();
    expect(matchLabel(withSide("away"))).toBe("Arsenal vs Chelsea (with Chelsea)");
    expect(matchLabel(withSide())).toBe("Arsenal vs Chelsea");
    await book({ partySize: 4 });
    await book({ partySize: 3, match: withSide("away") });
    await book({ partySize: 2, match: withSide() });
    const cancelled = await book({ partySize: 6 });
    await guestEdit(cancelled.id, { status: "cancelled" });
    expect(supporterTally(await readReservations(date))).toEqual([{ fixture: expect.objectContaining({ id: "fixture-1" }), home: 4, away: 3, neutral: 2 }]);
  });

  it("keeps the fixture when only the side is edited, and drops it for a different match", () => {
    expect(editedMatchPreference(withSide("home"), "Arsenal vs Chelsea", "away")).toEqual(withSide("away"));
    expect(editedMatchPreference(withSide("home"), "Arsenal vs Chelsea", "neutral")).toEqual(withSide());
    expect(editedMatchPreference(withSide("home"), "Arsenal vs Chelsea")).toEqual(withSide("home"));
    expect(editedMatchPreference(withSide("home"), "The rugby", "away")).toEqual({ kind: "other", request: "The rugby" });
  });
});

describe("asking to hear about a team", () => {
  it("is recorded only when the guest ticks it with a side chosen, and the guest sees only the team", async () => {
    const asked = await book({ teamUpdates: true }, undefined, now);
    expect(asked.teamUpdates).toEqual({ team: "Arsenal", at: now.toISOString() });
    expect(guestReservation(asked).teamUpdates).toEqual({ team: "Arsenal" });
    expect((await book()).teamUpdates).toBeUndefined();
    expect((await book({ teamUpdates: true, match: withSide() })).teamUpdates).toBeUndefined();
    expect((await book({ teamUpdates: true, match: { kind: "none" } })).teamUpdates).toBeUndefined();
  });

  it("cannot be given by staff, on a new booking or an existing one", async () => {
    expect((await book({ teamUpdates: true, source: "phone" }, "host")).teamUpdates).toBeUndefined();
    const record = await book();
    await expect(updateReservation(record.id, { version: record.version, teamUpdates: true }, "host", later(1))).rejects.toMatchObject({ status: 403 });
    expect((await readReservation(record.id))!.teamUpdates).toBeUndefined();
  });

  it("lets the guest start and stop it, and staff stop it on their behalf", async () => {
    const record = await book();
    const started = await guestEdit(record.id, { teamUpdates: true });
    expect(started.teamUpdates).toEqual({ team: "Arsenal", at: later(1).toISOString() });
    expect(started.history.at(-1)).toMatchObject({ actor: "Guest", action: "Asked for team updates" });
    // Saving again without a change keeps the original moment of consent.
    expect((await guestEdit(record.id, { teamUpdates: true, notes: "By the window" }, later(2))).teamUpdates?.at).toBe(later(1).toISOString());
    expect((await guestEdit(record.id, { teamUpdates: false }, later(3))).teamUpdates).toBeUndefined();
    await guestEdit(record.id, { teamUpdates: true }, later(4));
    const stopped = await updateReservation(record.id, { version: (await readReservation(record.id))!.version, teamUpdates: false }, "host", later(5));
    expect(stopped.teamUpdates).toBeUndefined();
    expect(stopped.history.at(-1)).toMatchObject({ actor: "host", action: "Stopped team updates" });
  });

  it("ends when the guest changes side or match, and follows them if they ask again", async () => {
    const record = await book({ teamUpdates: true });
    expect((await guestEdit(record.id, { match: withSide("away") })).teamUpdates).toBeUndefined();
    expect((await guestEdit(record.id, { match: withSide("away"), teamUpdates: true }, later(2))).teamUpdates).toEqual({ team: "Chelsea", at: later(2).toISOString() });
    expect((await guestEdit(record.id, { match: withSide() }, later(3))).teamUpdates).toBeUndefined();
    const other = await book({ teamUpdates: true });
    expect((await guestEdit(other.id, { match: { kind: "none" } })).teamUpdates).toBeUndefined();
  });
});

describe("the manager's supporter list", () => {
  it("lists only guests who asked, once per team, by their most recent booking with that team", async () => {
    await book({ name: "Asked Guest", email: "asked@example.com", teamUpdates: true });
    await book({ name: "Silent Guest", email: "silent@example.com" });
    await book({ name: "Away Guest", email: "away@example.com", match: withSide("away"), teamUpdates: true });
    await book({ name: "Neutral Guest", email: "neutral@example.com", match: withSide() });
    // Asked once, then booked with the same team again without asking: the later booking decides.
    await book({ name: "Lapsed Guest", email: "lapsed@example.com", teamUpdates: true }, undefined, now);
    await book({ name: "Lapsed Guest", email: "lapsed@example.com", time: "17:00" }, undefined, later(60));
    // Asked on both bookings: listed once.
    await book({ name: "Keen Guest", email: "keen@example.com", teamUpdates: true }, undefined, now);
    await book({ name: "Keen Guest", email: "keen@example.com", time: "17:00", teamUpdates: true }, undefined, later(60));
    const records = await readReservations();
    expect(supporterContacts(records).map((c) => [c.team, c.email])).toEqual([
      ["Arsenal", "asked@example.com"],
      ["Arsenal", "keen@example.com"],
      ["Chelsea", "away@example.com"],
    ]);
    expect(supporterTeams(records)).toEqual([
      { team: "Arsenal", guests: 4, contactable: 2 },
      { team: "Chelsea", guests: 1, contactable: 1 },
    ]);
  });

  it("drops a guest who withdraws, and one whose details were removed", async () => {
    const withdrawn = await book({ email: "withdrawn@example.com", teamUpdates: true });
    const erased = await book({ email: "erased@example.com", teamUpdates: true });
    await guestEdit(withdrawn.id, { teamUpdates: false });
    const removed = anonymized((await readReservation(erased.id))!, "manager", later(1));
    expect(removed.teamUpdates).toBeUndefined();
    expect(supporterContacts([(await readReservation(withdrawn.id))!, removed])).toEqual([]);
    expect(supporterTeams([removed])).toEqual([]);
  });

  it("shows the team in the guest book without any contact details", async () => {
    const [visit] = visitHistory([await book({ teamUpdates: true })]);
    expect(visit).toMatchObject({ team: "Arsenal", teamUpdates: true });
    expect(JSON.stringify(visit)).not.toContain("@example.com");
  });
});
