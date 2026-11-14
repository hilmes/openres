// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

vi.mock("server-only", () => ({}));
import { availability, DEFAULT_SETTINGS, guestReservation, TABLES, type Settings } from "./model";
import { advanceWaitlist, advanceWaitlistIfDue, createReservation, updateReservation } from "./service";
import { readAvailabilityInventory, readReservation, readSettings } from "./store";

const folder = mkdtempSync(join(tmpdir(), "openres-waitlist-test-"));
const file = join(folder, "reservations.sqlite");
const now = new Date("2026-11-12T17:00:00Z"); // Noon in New York
const later = (minutes: number) => new Date(now.getTime() + minutes * 60000);
const date = "2026-11-13";
let db: Database.Database;
let clock = 0;

function settings(patch: Partial<Settings> = {}) {
  db.prepare("UPDATE openres_settings SET payload = ? WHERE id = 1").run(JSON.stringify({
    ...structuredClone(DEFAULT_SETTINGS), enabled: true, waitlistOffers: true, offerMinutes: 15,
    // One two-top, so every test is about who gets the last table.
    disabledTables: TABLES.filter((t) => t.id !== "11").map((t) => t.id), ...patch,
  }));
}
function input(patch = {}) {
  return { id: randomUUID(), requestKey: randomUUID(), date, time: "18:00", partySize: 2, area: "any", name: "Test Guest", email: `${randomUUID()}@example.com`, phone: "", ...patch };
}
/** Bookings are created a minute apart so the waitlist order is unambiguous. */
const book = async (patch = {}, actor?: string) => (await createReservation(input(patch), actor, undefined, later(clock++ / 60))).reservation;
const cancel = async (id: string) => updateReservation(id, { version: (await readReservation(id))!.version, status: "cancelled" }, "host", now);

beforeAll(async () => {
  vi.stubEnv("OPENRES_DEMO", "1");
  vi.stubEnv("OPENRES_SQLITE_PATH", file);
  vi.stubEnv("OPENRES_SEED", "0");
  vi.stubEnv("VERCEL", "");
  await readSettings();
  db = new Database(file);
});
beforeEach(() => {
  clock = 0;
  db.exec("DELETE FROM openres_reservations; DELETE FROM openres_limits;");
  settings();
});
afterAll(() => {
  db.close();
  vi.unstubAllEnvs();
  rmSync(folder, { recursive: true, force: true });
});

describe("waitlist offers", () => {
  it("stays manual unless the venue switches offers on", async () => {
    settings({ waitlistOffers: false });
    const seated = await book();
    const waiting = await book({ waitlist: true });
    await cancel(seated.id);
    expect(await advanceWaitlist(date, now)).toEqual([]);
    expect((await readReservation(waiting.id))?.offer).toBeUndefined();
  });

  it("holds a freed table for the first waitlisted party and no one behind them", async () => {
    const seated = await book();
    const first = await book({ waitlist: true }), second = await book({ waitlist: true });
    expect(await advanceWaitlist(date, now)).toEqual([]); // nothing is free yet
    await cancel(seated.id);
    const offered = await advanceWaitlist(date, now);
    expect(offered.map((r) => r.id)).toEqual([first.id]);
    const record = (await readReservation(first.id))!;
    expect(record).toMatchObject({ status: "waitlisted", tableId: null, version: 2, offer: { tableId: "11", offeredAt: now.toISOString(), expiresAt: later(15).toISOString() } });
    expect(record.history.at(-1)).toMatchObject({ actor: "System", action: "Offered a table", fields: ["offer"] });
    expect((await readReservation(second.id))?.offer).toBeUndefined();
    // A second pass changes nothing while the offer stands.
    expect(await advanceWaitlist(date, later(5))).toEqual([]);
  });

  it("keeps the held table off online availability and away from another guest", async () => {
    const waiting = await book({ waitlist: true });
    await advanceWaitlist(date, now);
    const inventory = await readAvailabilityInventory(date);
    expect(availability(date, 2, "any", inventory.reservations, inventory.settings, now).some((slot) => slot.time === "18:00")).toBe(false);
    await expect(createReservation(input(), undefined, undefined, now)).rejects.toMatchObject({ status: 409 });
    // An adjacent visit that does not overlap the held one is still bookable.
    expect((await createReservation(input({ time: "20:00" }), undefined, undefined, now)).reservation.tableId).toBe("11");
    expect((await readReservation(waiting.id))?.offer?.tableId).toBe("11");
  });

  it("lets the guest confirm from their link, and only while the offer is live", async () => {
    const waiting = await book({ waitlist: true });
    await expect(updateReservation(waiting.id, { version: 1, status: "confirmed" }, undefined, now)).rejects.toMatchObject({ status: 403 });
    await advanceWaitlist(date, now);
    expect(guestReservation((await readReservation(waiting.id))!)).toMatchObject({ offer: { expiresAt: later(15).toISOString() } });
    expect(JSON.stringify(guestReservation((await readReservation(waiting.id))!).offer)).not.toContain("tableId");
    await expect(updateReservation(waiting.id, { version: 2, status: "seated" }, undefined, later(1))).rejects.toMatchObject({ status: 403 });
    const confirmed = await updateReservation(waiting.id, { version: 2, status: "confirmed" }, undefined, later(10));
    expect(confirmed).toMatchObject({ status: "confirmed", tableId: "11" });
    expect(confirmed.offer).toBeUndefined();
    expect(guestReservation(confirmed)).not.toHaveProperty("offer");
  });

  it("refuses a late confirmation and passes the table to the next party", async () => {
    const first = await book({ waitlist: true }), second = await book({ waitlist: true });
    await advanceWaitlist(date, now);
    await expect(updateReservation(first.id, { version: 2, status: "confirmed" }, undefined, later(16))).rejects.toMatchObject({ status: 403 });
    expect((await advanceWaitlist(date, later(16))).map((r) => r.id)).toEqual([second.id]);
    expect(await readReservation(first.id)).toMatchObject({ status: "waitlisted", offersMissed: 1 });
    expect((await readReservation(first.id))?.offer).toBeUndefined();
    expect((await readReservation(first.id))?.history.at(-1)).toMatchObject({ action: "Table offer expired" });
    // When the second party also lets it lapse, the first gets another turn rather than losing their place for good.
    expect((await advanceWaitlist(date, later(32))).map((r) => r.id)).toEqual([first.id]);
  });

  it("skips a party the table does not fit or whose time has passed", async () => {
    const big = await book({ waitlist: true, partySize: 6 });
    const early = await book({ waitlist: true, time: "13:00", date: "2026-11-12" });
    const fits = await book({ waitlist: true });
    expect((await advanceWaitlist(date, now)).map((r) => r.id)).toEqual([fits.id]);
    // By 1:30 PM the 1:00 PM request is in the past.
    expect(await advanceWaitlist("2026-11-12", later(90))).toEqual([]);
    expect((await readReservation(big.id))?.offer).toBeUndefined();
    expect((await readReservation(early.id))?.offer).toBeUndefined();
  });

  it("leaves staff in charge: they can take a held table, and the offer then fails cleanly", async () => {
    const waiting = await book({ waitlist: true });
    await advanceWaitlist(date, now);
    const phone = await book({ source: "phone", tableId: "11" }, "host");
    expect(phone).toMatchObject({ status: "confirmed", tableId: "11" });
    await expect(updateReservation(waiting.id, { version: 2, status: "confirmed" }, undefined, later(5))).rejects.toMatchObject({ status: 409 });
    expect(await readReservation(waiting.id)).toMatchObject({ status: "waitlisted", tableId: null });
  });

  it("ends the offer when the guest changes the request or staff promote them", async () => {
    const moved = await book({ waitlist: true });
    await advanceWaitlist(date, now);
    expect((await updateReservation(moved.id, { version: 2, time: "19:00" }, undefined, later(1))).offer).toBeUndefined();
    await cancel(moved.id);
    const promoted = await book({ waitlist: true });
    await advanceWaitlist(date, later(2));
    const confirmed = await updateReservation(promoted.id, { version: 2, status: "confirmed" }, "host", later(3));
    expect(confirmed).toMatchObject({ status: "confirmed", tableId: "11" });
    expect(confirmed.offer).toBeUndefined();
  });

  it("checks a date at most once a minute from desk reads", async () => {
    const first = await book({ waitlist: true });
    expect((await advanceWaitlistIfDue(date, now)).map((r) => r.id)).toEqual([first.id]);
    await cancel(first.id);
    const second = await book({ waitlist: true });
    expect(await advanceWaitlistIfDue(date, later(0.5))).toEqual([]);
    expect((await advanceWaitlistIfDue(date, later(1.5))).map((r) => r.id)).toEqual([second.id]);
  });
});
