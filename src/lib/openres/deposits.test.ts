// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

vi.mock("server-only", () => ({}));
/** A stand-in provider: payments live in memory and "the guest pays" by flipping a flag. */
const provider = vi.hoisted(() => {
  const intents = new Map<string, { amount: number; paid: boolean; refunded: boolean; cancelled: boolean }>();
  const state = { installed: true, failCreate: false, failRefund: false, intents };
  const adapter = {
    currency: "usd",
    async create({ reservationId, amount }: { reservationId: string; amount: number }) {
      if (state.failCreate) throw new Error("provider down");
      const id = `pi_${reservationId}`;
      if (!intents.has(id)) intents.set(id, { amount, paid: false, refunded: false, cancelled: false });
      return { id, clientSecret: `${id}_secret` };
    },
    async status(id: string) {
      const intent = intents.get(id)!;
      return { paid: intent.paid && !intent.cancelled, amount: intent.amount };
    },
    async refund(id: string) {
      if (state.failRefund) throw new Error("refund refused");
      intents.get(id)!.refunded = true;
    },
    async cancel(id: string) {
      intents.get(id)!.cancelled = true;
    },
  };
  return { state, adapter };
});
vi.mock("@/config/payments", () => ({ get paymentAdapter() { return provider.state.installed ? provider.adapter : null; } }));

import { depositDue, DEFAULT_SETTINGS, guestReservation, NO_DEPOSIT, TABLES, type Settings } from "./model";
import { confirmPayment, createReservation, refundDepositNow, settleDeposit, settleLapsedDeposits, updateReservation, updateSettings } from "./service";
import { readReservation, readSettings } from "./store";

const folder = mkdtempSync(join(tmpdir(), "openres-deposits-test-"));
const file = join(folder, "reservations.sqlite");
const now = new Date("2026-11-12T17:00:00Z"); // Noon in New York; the visit below is 6 PM the next day
const later = (minutes: number) => new Date(now.getTime() + minutes * 60000);
const date = "2026-11-13";
let db: Database.Database;

function settings(patch: Partial<Settings> = {}) {
  db.prepare("UPDATE openres_settings SET payload = ? WHERE id = 1").run(JSON.stringify({
    ...structuredClone(DEFAULT_SETTINGS), enabled: true, disabledTables: TABLES.filter((t) => t.id !== "11").map((t) => t.id),
    deposit: { ...NO_DEPOSIT, enabled: true, perGuest: 2000, refundHours: 24, payMinutes: 10 }, ...patch,
  }));
}
const input = (patch = {}) => ({ id: randomUUID(), requestKey: randomUUID(), date, time: "18:00", partySize: 2, area: "any", name: "Test Guest", email: `${randomUUID()}@example.com`, phone: "", ...patch });
const book = (patch = {}, actor?: string, at = now) => createReservation(input(patch), actor, undefined, at);
const pay = (id: string) => { provider.state.intents.get(`pi_${id}`)!.paid = true; };
/** A booking whose deposit has been paid and recorded. */
async function paidBooking(patch = {}) {
  const { reservation } = await book(patch);
  pay(reservation.id);
  return confirmPayment(reservation.id, later(1));
}
const guestCancel = async (id: string, at: Date) => {
  await updateReservation(id, { version: (await readReservation(id))!.version, status: "cancelled" }, undefined, at);
  return settleDeposit(id, at);
};
const staff = async (id: string, status: string, at = later(2)) => {
  await updateReservation(id, { version: (await readReservation(id))!.version, status }, "host", at);
  return settleDeposit(id, at);
};

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
  provider.state.intents.clear();
  Object.assign(provider.state, { installed: true, failCreate: false, failRefund: false });
  settings();
});
afterAll(() => {
  db.close();
  vi.unstubAllEnvs();
  rmSync(folder, { recursive: true, force: true });
});

describe("when a deposit applies", () => {
  it("takes none unless the venue switches deposits on", async () => {
    settings({ deposit: { ...NO_DEPOSIT } });
    const result = await book();
    expect(result.reservation.payment).toBeUndefined();
    expect(result).not.toHaveProperty("payment");
    expect(provider.state.intents.size).toBe(0);
  });

  it("follows the venue's rules for party size and match bookings", () => {
    const rule = { ...NO_DEPOSIT, enabled: true, perGuest: 2500, minParty: 4 };
    expect(depositDue({ partySize: 3 }, { deposit: rule })).toBe(0);
    expect(depositDue({ partySize: 4 }, { deposit: rule })).toBe(10000);
    expect(depositDue({ partySize: 6, match: { kind: "none" } }, { deposit: { ...rule, fixturesOnly: true } })).toBe(0);
    expect(depositDue({ partySize: 6, match: { kind: "fixture", fixture: { id: "f", date, time: "15:00", home: "A", away: "B", competition: "Cup" } } }, { deposit: { ...rule, fixturesOnly: true } })).toBe(15000);
  });

  it("cannot be switched on without a payment provider, and refuses bookings if the provider goes away", async () => {
    provider.state.installed = false;
    const current = await readSettings();
    await expect(updateSettings({ ...current, deposit: { ...NO_DEPOSIT, enabled: true } }, "manager")).rejects.toMatchObject({ status: 409 });
    await expect(book()).rejects.toMatchObject({ status: 503 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM openres_reservations").get()).toEqual({ n: 0 });
  });

  it("takes none for staff entries or waitlist requests", async () => {
    expect((await book({ source: "phone" }, "host")).reservation.payment).toBeUndefined();
    expect((await book({ waitlist: true })).reservation.payment).toBeUndefined();
  });
});

describe("paying", () => {
  it("holds the table while the guest pays and hands the browser only a client secret", async () => {
    const result = await book();
    expect(result.reservation).toMatchObject({ status: "confirmed", tableId: "11", payment: { amount: 4000, currency: "usd", status: "pending", intentId: `pi_${result.reservation.id}`, expiresAt: later(10).toISOString(), refundableUntil: "2026-11-12T23:00:00.000Z" } });
    expect(result).toMatchObject({ payment: { clientSecret: `pi_${result.reservation.id}_secret`, amount: 4000, currency: "usd" } });
    const projected = guestReservation(result.reservation);
    expect(projected.payment).toEqual({ amount: 4000, currency: "usd", status: "pending", expiresAt: later(10).toISOString(), refundableUntil: "2026-11-12T23:00:00.000Z" });
    expect(JSON.stringify(projected)).not.toContain("pi_");
    // The table is taken for other guests while the payment is in progress.
    await expect(book({}, undefined, later(5))).rejects.toMatchObject({ status: 409 });
  });

  it("returns the same payment when the booking request is retried", async () => {
    const request = input();
    const first = await createReservation(request, undefined, undefined, now);
    const second = await createReservation(request, undefined, undefined, later(1));
    expect(second.created).toBe(false);
    expect(second).toMatchObject({ payment: (first as { payment: unknown }).payment });
    expect(provider.state.intents.size).toBe(1);
  });

  it("believes the provider, not the browser: unpaid or underpaid is refused", async () => {
    const { reservation } = await book();
    await expect(confirmPayment(reservation.id, later(1))).rejects.toMatchObject({ status: 402 });
    const intent = provider.state.intents.get(`pi_${reservation.id}`)!;
    Object.assign(intent, { paid: true, amount: 100 });
    await expect(confirmPayment(reservation.id, later(1))).rejects.toMatchObject({ status: 402 });
    expect((await readReservation(reservation.id))?.payment?.status).toBe("pending");
  });

  it("records a paid deposit once", async () => {
    const paid = await paidBooking();
    expect(paid).toMatchObject({ status: "confirmed", payment: { status: "paid", paidAt: later(1).toISOString() } });
    expect(paid.payment?.expiresAt).toBeUndefined();
    expect(paid.history.at(-1)).toMatchObject({ action: "Deposit paid", fields: ["payment"] });
    expect((await confirmPayment(paid.id, later(2))).version).toBe(paid.version);
  });

  it("releases the booking and charges nothing when the provider cannot start the payment", async () => {
    provider.state.failCreate = true;
    const request = input();
    await expect(createReservation(request, undefined, undefined, now)).rejects.toMatchObject({ status: 503 });
    expect(await readReservation(request.id)).toMatchObject({ status: "cancelled", payment: { status: "void" } });
    provider.state.failCreate = false;
    expect((await book()).reservation.tableId).toBe("11");
  });
});

describe("running out of time to pay", () => {
  it("stops holding the table and is cancelled on the next pass, with the payment voided", async () => {
    const { reservation } = await book();
    // Even before any pass runs, another guest can take the table once the time to pay is up.
    const other = await book({}, undefined, later(11));
    expect(other.reservation.tableId).toBe("11");
    await settleLapsedDeposits(date, later(11), true);
    expect(await readReservation(reservation.id)).toMatchObject({ status: "cancelled", payment: { status: "void" } });
    expect((await readReservation(reservation.id))?.history.at(-1)).toMatchObject({ action: "Deposit not completed in time" });
    expect(provider.state.intents.get(`pi_${reservation.id}`)?.cancelled).toBe(true);
    expect((await readReservation(other.reservation.id))?.status).toBe("confirmed");
  });

  it("confirms a guest who paid but never came back to the page", async () => {
    const { reservation } = await book();
    pay(reservation.id);
    await settleLapsedDeposits(date, later(11), true);
    expect(await readReservation(reservation.id)).toMatchObject({ status: "confirmed", tableId: "11", payment: { status: "paid" } });
  });

  it("refunds in full when the money arrives after the table went to someone else", async () => {
    const { reservation } = await book();
    await book({}, undefined, later(11));
    pay(reservation.id);
    await expect(confirmPayment(reservation.id, later(12))).rejects.toMatchObject({ status: 409, message: expect.stringContaining("refunded in full") });
    expect(await readReservation(reservation.id)).toMatchObject({ status: "cancelled", payment: { status: "refunded" } });
    expect(provider.state.intents.get(`pi_${reservation.id}`)?.refunded).toBe(true);
  });
});

describe("after the booking ends", () => {
  it("refunds a guest who cancels before the cutoff they were shown", async () => {
    const paid = await paidBooking();
    expect(await guestCancel(paid.id, new Date("2026-11-12T22:59:00Z"))).toMatchObject({ status: "cancelled", payment: { status: "refunded" } });
    expect(provider.state.intents.get(`pi_${paid.id}`)?.refunded).toBe(true);
  });

  it("keeps the deposit when a guest cancels after the cutoff", async () => {
    const paid = await paidBooking();
    const settled = await guestCancel(paid.id, new Date("2026-11-12T23:01:00Z"));
    expect(settled).toMatchObject({ status: "cancelled", payment: { status: "forfeited" } });
    expect(settled?.history.at(-1)).toMatchObject({ action: "Deposit kept: cancelled after the refund cutoff" });
    expect(provider.state.intents.get(`pi_${paid.id}`)?.refunded).toBe(false);
  });

  it("uses the policy from when the guest booked, not a later change", async () => {
    const paid = await paidBooking();
    settings({ deposit: { ...NO_DEPOSIT, enabled: true, refundHours: 72 } });
    expect((await guestCancel(paid.id, new Date("2026-11-12T22:00:00Z")))?.payment?.status).toBe("refunded");
  });

  it("always refunds when the venue cancels, keeps it for a no-show, and applies it for a completed visit", async () => {
    const cancelled = await paidBooking();
    expect((await staff(cancelled.id, "cancelled", new Date("2026-11-13T22:30:00Z")))?.payment?.status).toBe("refunded");
    const missed = await paidBooking();
    expect((await staff(missed.id, "no_show"))?.payment?.status).toBe("forfeited");
    const came = await paidBooking();
    const doors = new Date("2026-11-13T23:00:00Z"); // 6 PM in New York on the day
    await updateReservation(came.id, { version: came.version, status: "seated" }, "host", doors);
    // Seating settles nothing: the deposit is still the guest's until the visit ends.
    expect((await settleDeposit(came.id, doors))?.payment?.status).toBe("paid");
    const done = await staff(came.id, "completed", new Date(doors.getTime() + 90 * 60000));
    expect(done).toMatchObject({ status: "completed", payment: { status: "applied" } });
    expect(done?.history.at(-1)).toMatchObject({ action: "Deposit applied to the bill" });
    expect(provider.state.intents.get(`pi_${came.id}`)?.refunded).toBe(false);
  });

  it("voids an unpaid deposit when the booking is cancelled first", async () => {
    const { reservation } = await book();
    expect(await guestCancel(reservation.id, later(2))).toMatchObject({ status: "cancelled", payment: { status: "void" } });
    expect(provider.state.intents.get(`pi_${reservation.id}`)?.cancelled).toBe(true);
  });

  it("flags a refund the provider refuses and lets a manager retry", async () => {
    const paid = await paidBooking();
    provider.state.failRefund = true;
    expect(await staff(paid.id, "cancelled")).toMatchObject({ payment: { status: "paid", refundFailed: true } });
    await expect(refundDepositNow(paid.id, "manager", later(4))).rejects.toMatchObject({ status: 502 });
    provider.state.failRefund = false;
    expect(await refundDepositNow(paid.id, "manager", later(5))).toMatchObject({ payment: { status: "refunded", refundFailed: false } });
    await expect(refundDepositNow(paid.id, "manager", later(6))).rejects.toMatchObject({ status: 409 });
  });

  it("lets a manager return a deposit that was kept", async () => {
    const paid = await paidBooking();
    await staff(paid.id, "no_show");
    expect(await refundDepositNow(paid.id, "manager", later(5))).toMatchObject({ payment: { status: "refunded" } });
    expect((await readReservation(paid.id))?.history.at(-1)).toMatchObject({ actor: "manager", action: "Deposit refunded" });
  });
});
