import "server-only";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { venue } from '@/config/venue';
import { paymentAdapter } from '@/config/payments';
const floorPlanRevision = createHash('sha256').update(JSON.stringify(venue.floor) + JSON.stringify(venue.tables)).digest('hex');
import {
  addDays,
  availableTables,
  BookingError,
  depositDue,
  depositLapsed,
  FINAL_STATUSES,
  FORMER_GUEST,
  liveOffer,
  bookingSchema,
  minutes,
  timeString,
  settingsSchema,
  STATUSES,
  TRANSITIONS,
  validateSlot,
  venueNow,
  type Reservation,
  type BookingFixture,
  type MatchPreference,
  type Payment,
  type VisitHistory,
} from "./model";
import { wallTimeToISO } from "./time";
import { claimOnce, consumeAuthLimit, localMode, readReservation, readReservations, readSettings, withGuestRecords, withInventory } from "./store";
import { visitorContact } from "./visitors";

function secret() {
  const key = localMode()
    ? "openres-local-preview-only"
    : process.env.OPENRES_TOKEN_SECRET;
  if (!key || (!localMode() && key.length < 32))
    throw new BookingError("Reservation management is not configured.", 503);
  return key;
}
export function managementToken(id: string) {
  return createHmac("sha256", secret())
    .update(`openres:manage:${id}`)
    .digest("base64url");
}
export function verifyManagementToken(id: string, token: string) {
  const expected = Buffer.from(managementToken(id));
  const actual = Buffer.from(token);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
export function requestRateKey(ip: string) {
  return createHmac("sha256", secret())
    .update(`openres:rate:${ip}`)
    .digest("hex");
}
/** A venue-only projection; contact information and free-text notes never reach the history UI. */
export function visitHistory(records: Reservation[]): VisitHistory[] {
  return records.map((r) => {
    const contact = visitorContact(r);
    const identity = contact ? `${contact.kind}:${contact.value}` : `reservation:${r.id}`;
    return {
      id: r.id,
      name: r.name,
      date: r.date,
      time: r.time,
      partySize: r.partySize,
      status: r.status,
      guestKey: createHmac("sha256", secret())
        .update(`openres:venue-visit-history:${identity}`)
        .digest("hex"),
    };
  });
}
function fixtureDigest(f: BookingFixture, captured: string) {
  return createHmac("sha256", secret())
    .update(
      JSON.stringify([
        "openres:fixture",
        captured,
        f.id,
        f.date,
        f.time,
        f.home,
        f.away,
        f.competition,
      ]),
    )
    .digest("base64url");
}
/** Attests only that this snapshot came through our calendar adapter, not that the venue will screen it. */
export function attestFixture(
  f: BookingFixture,
  now = new Date(),
): BookingFixture {
  const captured = String(now.getTime());
  return { ...f, proof: `${captured}.${fixtureDigest(f, captured)}` };
}
function matchProvenance(
  match: MatchPreference,
  now: Date,
): NonNullable<Reservation["provenance"]>["match"] {
  const recordedAt = now.toISOString();
  if (match.kind !== "fixture")
    return {
      source: match.kind === "other" ? "match_request" : "no_preference",
      recordedAt,
    };
  const f = match.fixture;
  const [captured, signature] = (f.proof || "").split(".");
  const capturedMs = Number(captured);
  const expected = Buffer.from(fixtureDigest(f, captured || ""));
  const actual = Buffer.from(signature || "");
  const verified =
    /^\d{13}$/.test(captured || "") &&
    capturedMs <= now.getTime() + 60000 &&
    now.getTime() - capturedMs <= 86400000 &&
    actual.length === expected.length &&
    timingSafeEqual(actual, expected);
  return {
    source: verified
      ? localMode()
        ? "sample_fixture"
        : "calendar_feed"
      : "supplied_fixture",
    sourceId: f.id,
    ...(verified
      ? {
          reference: localMode()
            ? "local sample fixtures"
            : "operator-configured fixture catalog",
        }
      : {}),
    ...(verified ? { capturedAt: new Date(capturedMs).toISOString() } : {}),
    recordedAt,
  };
}
function auditState(r: Reservation) {
  return {
    date: r.date,
    time: r.time,
    partySize: r.partySize,
    tableId: r.tableId,
    status: r.status,
  };
}
export const createSchema = bookingSchema.extend({
  requestKey: z.string().uuid(),
  source: z.enum(["online", "phone", "walk_in"]).default("online"),
  waitlist: z.boolean().default(false),
});
const staffCreateSchema = createSchema.extend({
  requestKey: createSchema.shape.requestKey.optional(),
  tableId: z.string().optional(),
  email: z
    .union([
      z
        .string()
        .trim()
        .email()
        .max(254)
        .transform((s) => s.toLowerCase()),
      z.literal(""),
    ])
    .default(""),
  phone: z.union([bookingSchema.shape.phone, z.literal("")]).default(""),
});
export async function createReservation(
  raw: unknown,
  actor?: string,
  rateKey?: string,
  now = new Date(),
) {
  const input = (actor ? staffCreateSchema : createSchema).parse(raw);
  // Consume outside the inventory transaction: rejected bookings still cost an attempt.
  if (!actor && rateKey) await consumeAuthLimit(
    `booking:${rateKey}`, 8, Date.now() + 3600000,
    'Too many requests. Please try again in an hour or contact the venue.',
  );
  const requestKeyHash = input.requestKey
    ? createHash('sha256').update(input.requestKey).digest('hex')
    : undefined;
  const token = managementToken(input.id);
  const result = await withInventory(
    input.date,
    input.id,
    (inventory) => {
      const existing = inventory.reservations.find((r) => r.id === input.id);
      if (existing) {
        // Public IDs and contact details are not authentication. Legacy rows without
        // a retry hash must use their original management link instead.
        if (
          (!actor && (!existing.requestKeyHash || existing.requestKeyHash !== requestKeyHash)) ||
          existing.email !== input.email ||
          existing.name !== input.name ||
          existing.phone !== input.phone
        )
          throw new BookingError(
            "Please retry with a new booking request.",
            409,
          );
        return { reservation: existing, created: false };
      }
      const { settings, reservations } = inventory;
      if (!actor && !settings.enabled)
        throw new BookingError(
          "Online reservations are not open yet. Please contact the venue.",
          503,
        );
      validateSlot(input, settings, now, !!actor);
      if (
        input.match.kind === "fixture" &&
        input.match.fixture.date !== input.date
      )
        throw new BookingError(
          "Choose the fixture date, or change your match preference.",
        );
      if (actor && input.source === "walk_in" && !input.waitlist) {
        const clock = venueNow(now);
        if (
          input.date !== clock.date ||
          Math.abs(minutes(input.time) - clock.minutes) > 15
        )
          throw new BookingError(
            "Walk-ins must be seated now. Use a phone reservation for a future visit.",
          );
        input.time = timeString(clock.minutes);
      }
      if (
        !actor &&
        reservations.filter(
          (r) =>
            r.email === input.email &&
            r.date === input.date &&
            !["cancelled", "completed", "no_show"].includes(r.status),
        ).length >= 2
      )
        throw new BookingError(
          "You already have bookings for this date. Please manage an existing booking or contact us.",
          409,
        );
      const candidates = availableTables(
        input,
        reservations,
        settings,
        undefined,
        now,
        settings.duration,
        !actor,
      );
      const requestedTable = "tableId" in input ? input.tableId : undefined;
      const table = requestedTable
        ? candidates.find((t) => t.id === requestedTable)
        : candidates[0];
      if (!input.waitlist && !table)
        throw new BookingError(
          "That table was just booked. Please choose another time or join the waitlist.",
          409,
        );
      const at = now.toISOString();
      const reservation: Reservation = {
        id: input.id,
        ...(requestKeyHash ? { requestKeyHash } : {}),
        date: input.date,
        time: input.time,
        partySize: input.partySize,
        area: input.area,
        tableId: input.waitlist ? null : table!.id,
        duration: settings.duration,
        name: input.name,
        email: input.email,
        phone: input.phone,
        notes: input.notes,
        occasion: input.occasion,
        staffNotes: "",
        match: input.match,
        provenance: {
          system: "OpenRes",
          environment: localMode() ? "local_preview" : "live",
          createdBy: actor ? "staff" : "guest",
          actor: actor || "Guest",
          recordedAt: at,
          floorPlan: venue.floor.revision,
          floorPlanRevision,
          match: matchProvenance(input.match, now),
        },
        status: input.waitlist
          ? "waitlisted"
          : actor && input.source === "walk_in"
            ? "seated"
            : "confirmed",
        source: actor ? input.source : "online",
        createdAt: at,
        updatedAt: at,
        version: 1,
        history: [
          {
            at,
            actor: actor || "Guest",
            action: input.waitlist ? "Joined waitlist" : "Created reservation",
          },
        ],
      };
      reservation.history[0] = {
        ...reservation.history[0],
        version: 1,
        fields: ["created"],
        state: auditState(reservation),
        matchSource: reservation.provenance!.match.source,
      };
      // Online bookings pay the venue's deposit, if it asks for one. Staff entries and waitlist joins do not.
      const due = actor || input.waitlist ? 0 : depositDue(input, settings);
      if (due > 0) {
        if (!paymentAdapter) throw new BookingError("Deposits are not available right now. Please contact the venue.", 503);
        const start = Date.parse(wallTimeToISO(input.date, input.time, venue.timeZone));
        reservation.payment = {
          amount: due, currency: paymentAdapter.currency, status: "pending", intentId: "",
          expiresAt: new Date(now.getTime() + settings.deposit.payMinutes * 60000).toISOString(),
          refundableUntil: new Date(start - settings.deposit.refundHours * 3600000).toISOString(),
        };
        reservation.history[0].action = "Created reservation; deposit pending";
      }
      reservations.push(reservation);
      return { reservation, created: true };
    },
  );
  const pending = result.reservation.payment?.status === "pending" ? result.reservation.payment : null;
  if (!pending || actor) return { ...result, token };
  // The provider is called outside the inventory lock. A retry reaches the same payment.
  try {
    if (!paymentAdapter) throw new Error("No payment adapter");
    const intent = await paymentAdapter.create({ reservationId: input.id, amount: pending.amount, description: `${venue.name} deposit, ${input.date} ${input.time}, ${input.partySize} guests` });
    if (pending.intentId !== intent.id) await setPayment(input.date, input.id, { intentId: intent.id });
    return {
      ...result, token,
      reservation: { ...result.reservation, payment: { ...pending, intentId: intent.id } },
      payment: { clientSecret: intent.clientSecret, amount: pending.amount, currency: pending.currency, expiresAt: pending.expiresAt },
    };
  } catch {
    await releaseUnpaid(input.date, input.id, "Deposit could not be started", now).catch(() => {});
    throw new BookingError("We could not start the deposit payment. You have not been charged. Please try again.", 503);
  }
}
// PATCH must preserve omitted fields: Zod 4 applies defaults even inside .partial().
export const updateSchema = z.object({
    date: bookingSchema.shape.date.optional(),
    time: bookingSchema.shape.time.optional(),
    partySize: bookingSchema.shape.partySize.optional(),
    area: bookingSchema.shape.area.removeDefault().optional(),
    notes: bookingSchema.shape.notes.removeDefault().optional(),
    occasion: bookingSchema.shape.occasion.removeDefault().optional(),
    match: bookingSchema.shape.match.removeDefault().optional(),
    version: z.number().int().positive(),
    status: z.enum(STATUSES).optional(),
    tableId: z.string().optional(),
    staffNotes: z.string().trim().max(2000).optional(),
  });
export async function updateReservation(
  id: string,
  raw: unknown,
  actor?: string,
  now = new Date(),
) {
  const input = updateSchema.parse(raw);
  return withInventory(input.date || "", id, (inventory) => {
    const record = inventory.reservations.find((r) => r.id === id);
    if (!record) throw new BookingError("Reservation not found.", 404);
    if (record.version !== input.version)
      throw new BookingError(
        "This reservation changed. Refresh before trying again.",
        409,
      );
    if (
      !actor &&
      (input.staffNotes !== undefined ||
        input.tableId !== undefined ||
        // A guest may cancel, or confirm a table that is being held for them.
        (input.status && input.status !== "cancelled" && !(input.status === "confirmed" && liveOffer(record, now))))
    )
      throw new BookingError("This action is for staff only.", 403);
    if (!actor && !["confirmed", "waitlisted"].includes(record.status))
      throw new BookingError(
        "Please contact the venue to change this reservation.",
        409,
      );
    if (!actor) {
      const clock = venueNow(now);
      if (
        record.date < clock.date ||
        (record.date === clock.date && minutes(record.time) <= clock.minutes)
      )
        throw new BookingError(
          "Please contact the venue to change a reservation that has already started.",
          409,
        );
    }
    if (
      input.status &&
      input.status !== record.status &&
      !TRANSITIONS[record.status].includes(input.status)
    )
      throw new BookingError("This status change is not available.", 409);
    const next = {
      ...record,
      ...input,
      version: record.version + 1,
      updatedAt: now.toISOString(),
    };
    if (next.match?.kind === "fixture" && next.match.fixture.date !== next.date)
      throw new BookingError(
        "The fixture is on a different date. Change the match preference before moving your booking.",
      );
    const changesSlot =
      input.date !== undefined ||
      input.time !== undefined ||
      input.partySize !== undefined ||
      input.area !== undefined ||
      input.tableId !== undefined;
    const seatsParty = input.status === "seated" && record.status !== "seated";
    const movesSeatedParty =
      !!actor &&
      record.status === "seated" &&
      input.tableId !== undefined &&
      input.date === undefined &&
      input.time === undefined &&
      input.partySize === undefined &&
      input.area === undefined &&
      input.status === undefined;
    if (
      changesSlot &&
      !movesSeatedParty &&
      !["confirmed", "waitlisted", "arrived"].includes(record.status)
    )
      throw new BookingError("Only upcoming reservations can be moved.", 409);
    // Seating uses the actual service time so a late guest cannot collide with a later booking.
    if (seatsParty) {
      const clock = venueNow(now);
      if (next.date !== clock.date)
        throw new BookingError("Only today's guests can be seated.", 409);
      next.time = timeString(clock.minutes);
    }
    if (
      (changesSlot ||
        (record.status === "waitlisted" && next.status === "confirmed")) &&
      !seatsParty &&
      !movesSeatedParty
    )
      validateSlot(
        next,
        { ...inventory.settings, duration: next.duration },
        now,
        !!actor,
      );
    if (
      changesSlot ||
      seatsParty ||
      (record.status === "waitlisted" && next.status === "confirmed")
    ) {
      if (next.status !== "waitlisted") {
        const moveClock = venueNow(now);
        if (movesSeatedParty && next.date !== moveClock.date)
          throw new BookingError(
            "Close the previous service before moving this party.",
            409,
          );
        const moveTime = `${String(Math.floor(moveClock.minutes / 60)).padStart(2, "0")}:${String(moveClock.minutes % 60).padStart(2, "0")}`;
        const candidates = availableTables(
          movesSeatedParty ? { ...next, time: moveTime } : next,
          inventory.reservations,
          inventory.settings,
          id,
          now,
          movesSeatedParty
            ? Math.max(
                15,
                minutes(next.time) + next.duration - moveClock.minutes,
              )
            : next.duration,
          !actor,
        );
        const table = input.tableId
          ? candidates.find((t) => t.id === input.tableId)
          : candidates.find((t) => t.id === (record.offer?.tableId ?? record.tableId)) || candidates[0];
        if (!table)
          throw new BookingError(
            "No suitable table is free for this visit. Choose another table or time.",
            409,
          );
        next.tableId = table.id;
      }
    }
    // An offer belongs to the waitlisted request as it stood: any change of slot or status ends it.
    if (next.offer && (changesSlot || next.status !== "waitlisted")) delete next.offer;
    if (input.match && next.provenance)
      next.provenance = {
        ...next.provenance,
        match: matchProvenance(next.match, now),
      };
    next.history = [
      ...record.history,
      {
        at: next.updatedAt,
        actor: actor || "Guest",
        version: next.version,
        fields: Object.keys(input).filter((key) => key !== "version"),
        state: auditState(next),
        ...(input.match
          ? { matchSource: matchProvenance(next.match, now).source }
          : {}),
        action: movesSeatedParty
          ? "Moved seated party"
          : input.status
            ? `Status: ${input.status}`
            : changesSlot
              ? "Updated reservation / table"
              : input.match
                ? "Changed match preference"
                : "Updated notes",
      },
    ];
    inventory.reservations[inventory.reservations.indexOf(record)] = next;
    return next;
  });
}
export async function updateSettings(raw: unknown, actor = "System") {
  const input = settingsSchema.parse(raw);
  if (input.deposit.enabled && !paymentAdapter) throw new BookingError("No payment provider is set up for this installation, so deposits cannot be switched on.", 409);
  return withInventory("", "", (inventory) => {
    if (input.version !== inventory.settings.version)
      throw new BookingError("Settings changed. Refresh and try again.", 409);
    const changed = Object.keys(input).filter(
      (key) =>
        key !== "version" &&
        JSON.stringify(input[key as keyof typeof input]) !==
          JSON.stringify(inventory.settings[key as keyof typeof input]),
    );
    inventory.audit.push({
      actor,
      action: "settings_changed",
      scope: JSON.stringify({
        version: input.version + 1,
        fields: changed,
        settings: input,
        floorPlanRevision,
      }),
    });
    inventory.settings = { ...input, version: input.version + 1 };
    return inventory.settings;
  });
}

/**
 * Remove what identifies the guest and keep the visit: date, time, party, table, status and
 * source stay for reporting. The record can no longer be matched to a returning guest, and
 * its retry proof is dropped so the original browser cannot recover a receipt.
 */
export function anonymized(record: Reservation, actor: string, now = new Date()): Reservation {
  const { requestKeyHash: _retry, ...rest } = record;
  void _retry;
  const at = now.toISOString();
  const next: Reservation = {
    ...rest,
    name: FORMER_GUEST,
    email: "",
    phone: "",
    notes: "",
    staffNotes: "",
    occasion: "",
    // A typed match request is free text and can name people; a catalog fixture cannot.
    match: record.match?.kind === "other" ? { kind: "none" } : record.match,
    anonymizedAt: at,
    updatedAt: at,
    version: record.version + 1,
  };
  next.history = [
    ...record.history,
    { at, actor, action: "Guest details removed", version: next.version, fields: ["anonymized"], state: auditState(next) },
  ];
  return next;
}
const PURGE_BATCH = 500;
/**
 * Apply the venue's retention period: anonymize finished visits older than it. Active
 * bookings are never touched. Returns how many records changed and whether more remain.
 */
export async function purgeExpired(actor = "System", now = new Date()) {
  const days = (await readSettings()).retentionDays ?? null;
  if (!days) return { removed: 0, more: false, retentionDays: null };
  const before = addDays(venueNow(now).date, -days);
  return withGuestRecords({ kind: "expired", before, limit: PURGE_BATCH }, (inventory) => {
    // Re-read under the lock: a manager may have just switched retention off or lengthened it.
    const current = inventory.settings.retentionDays ?? null;
    if (!current) return { removed: 0, more: false, retentionDays: null };
    const cutoff = addDays(venueNow(now).date, -current);
    let removed = 0;
    inventory.reservations = inventory.reservations.map((record) => {
      if (record.anonymizedAt || record.date >= cutoff || !FINAL_STATUSES.includes(record.status)) return record;
      removed++;
      return anonymized(record, actor, now);
    });
    // Counts and the cutoff only: an audit entry must not carry what was just removed.
    if (removed) inventory.audit.push({ actor, action: "retention_purge", scope: `before=${cutoff}; records=${removed}` });
    return { removed, more: removed === PURGE_BATCH, retentionDays: current };
  });
}
let purgeCheckedOn = "";
/** Run the retention pass at most once per venue day, however many desks and server instances are open. */
export async function purgeIfDue(now = new Date()) {
  const today = venueNow(now).date;
  if (purgeCheckedOn === today) return;
  purgeCheckedOn = today;
  try {
    if (await claimOnce(`retention:${today}`, now.getTime() + 2 * 86400000)) await purgeExpired("System", now);
  } catch (error) {
    purgeCheckedOn = "";
    console.error("[openres] retention pass failed", error instanceof Error ? error.name : "UnknownError");
  }
}
/**
 * A manager erases one guest on request: every retained record sharing that reservation's
 * contact, whatever its age. Refused while the guest still has a booking in progress.
 */
export async function eraseGuest(id: string, actor: string, now = new Date()) {
  const target = await readReservation(id);
  if (!target) throw new BookingError("Reservation not found.", 404);
  if (target.anonymizedAt) throw new BookingError("This guest's details were already removed.", 409);
  const contact = visitorContact(target);
  return withGuestRecords(contact ? { kind: "contact", contact } : { kind: "id", id }, (inventory) => {
    const records = inventory.reservations.filter((record) => !record.anonymizedAt);
    if (!records.some((record) => record.id === id)) throw new BookingError("This reservation changed. Refresh before trying again.", 409);
    if (records.some((record) => !FINAL_STATUSES.includes(record.status)))
      throw new BookingError("This guest has a booking in progress. Cancel or complete it first.", 409);
    inventory.reservations = inventory.reservations.map((record) => (record.anonymizedAt ? record : anonymized(record, actor, now)));
    inventory.audit.push({ actor, action: "guest_erasure", scope: `records=${records.length}; matched=${contact?.kind || "record"}` });
    return { erased: records.length };
  });
}

/**
 * Move the waitlist for one service date: let lapsed offers go, then hold each free table
 * for the next waitlisted party it fits. Returns the parties newly offered a table, for the
 * caller to notify. Does nothing unless the venue switched waitlist offers on.
 */
export async function advanceWaitlist(date: string, now = new Date()): Promise<Reservation[]> {
  return withInventory(date, "", (inventory) => {
    const { settings } = inventory;
    if (!settings.waitlistOffers) return [];
    const at = now.toISOString();
    const touch = (record: Reservation, action: string, fields: string[]) => {
      record.version += 1;
      record.updatedAt = at;
      record.history = [...record.history, { at, actor: "System", action, version: record.version, fields, state: auditState(record) }];
    };
    const waiting = inventory.reservations.filter((r) => r.date === date && r.status === "waitlisted");
    for (const record of waiting) {
      if (!record.offer || liveOffer(record, now)) continue;
      delete record.offer;
      record.offersMissed = (record.offersMissed || 0) + 1;
      touch(record, "Table offer expired", ["offer"]);
    }
    const offered: Reservation[] = [];
    const queue = waiting
      .filter((r) => !r.offer)
      .sort((a, b) => (a.offersMissed || 0) - (b.offersMissed || 0) || a.createdAt.localeCompare(b.createdAt));
    for (const record of queue) {
      try {
        validateSlot(record, { ...settings, duration: record.duration }, now);
      } catch {
        continue; // The requested time has passed or the day closed; staff can still seat them.
      }
      // Earlier offers in this pass already count as held, so one table is never offered twice.
      const table = availableTables(record, inventory.reservations, settings, record.id, now, record.duration)[0];
      if (!table) continue;
      record.offer = { tableId: table.id, offeredAt: at, expiresAt: new Date(now.getTime() + (settings.offerMinutes ?? 15) * 60000).toISOString() };
      touch(record, "Offered a table", ["offer"]);
      offered.push(record);
    }
    return offered;
  });
}
const waitlistChecked = new Map<string, number>();
/** The same, at most once a minute per date and server instance: called from desk reads so offers expire without a scheduler. */
export async function advanceWaitlistIfDue(date: string, now = new Date()): Promise<Reservation[]> {
  if (now.getTime() - (waitlistChecked.get(date) || 0) < 60000) return [];
  if (waitlistChecked.size > 64) waitlistChecked.clear();
  waitlistChecked.set(date, now.getTime());
  try {
    return await advanceWaitlist(date, now);
  } catch (error) {
    console.error("[openres] waitlist pass failed", error instanceof Error ? error.name : "UnknownError");
    return [];
  }
}

/** Change a booking's payment record under the inventory lock, with an audit entry when it is an event. */
async function setPayment(date: string, id: string, patch: Partial<Payment>, action?: string, actor = "System", now = new Date()) {
  return withInventory(date, id, (inventory) => {
    const record = inventory.reservations.find((r) => r.id === id);
    if (!record?.payment) return record;
    record.payment = { ...record.payment, ...patch };
    if (action) {
      record.version += 1;
      record.updatedAt = now.toISOString();
      record.history = [...record.history, { at: record.updatedAt, actor, action, version: record.version, fields: ["payment"], state: auditState(record) }];
    }
    return record;
  });
}
/** Cancel a booking that was never paid for and void its payment. */
async function releaseUnpaid(date: string, id: string, action: string, now = new Date()) {
  const released = await withInventory(date, id, (inventory) => {
    const record = inventory.reservations.find((r) => r.id === id);
    if (!record || record.payment?.status !== "pending") return undefined;
    record.payment = { ...record.payment, status: "void", settledAt: now.toISOString() };
    delete record.payment.expiresAt;
    if (!["cancelled", "completed", "no_show"].includes(record.status)) record.status = "cancelled";
    record.version += 1;
    record.updatedAt = now.toISOString();
    record.history = [...record.history, { at: record.updatedAt, actor: "System", action, version: record.version, fields: ["status", "payment"], state: auditState(record) }];
    return record;
  });
  if (released?.payment?.intentId) await paymentAdapter?.cancel(released.payment.intentId).catch(() => {});
  return released;
}
/**
 * Record a deposit the provider says was paid. The provider is the source of truth: the amount
 * and success are read from it, never from the browser. If the booking lapsed and its table has
 * since gone to someone else, the guest is refunded in full instead.
 */
export async function confirmPayment(id: string, now = new Date()): Promise<Reservation> {
  const record = await readReservation(id);
  if (!record) throw new BookingError("Reservation not found.", 404);
  if (record.payment?.status !== "pending") return record;
  if (!paymentAdapter || !record.payment.intentId) throw new BookingError("Deposits are not available right now. Please contact the venue.", 503);
  const state = await paymentAdapter.status(record.payment.intentId);
  if (!state.paid || state.amount < record.payment.amount) throw new BookingError("The deposit has not been paid yet.", 402);
  let tableGone = false;
  const next = await withInventory(record.date, id, (inventory) => {
    const current = inventory.reservations.find((r) => r.id === id);
    if (!current?.payment || current.payment.status !== "pending") return current;
    const stillHeld = current.status === "confirmed" && (!depositLapsed(current, now) ||
      availableTables(current, inventory.reservations, inventory.settings, id, now, current.duration, false).some((t) => t.id === current.tableId));
    current.version += 1;
    current.updatedAt = now.toISOString();
    if (stillHeld) {
      current.payment = { ...current.payment, status: "paid", paidAt: current.updatedAt };
      delete current.payment.expiresAt;
    } else {
      tableGone = true;
      if (current.status === "confirmed") current.status = "cancelled";
    }
    current.history = [...current.history, { at: current.updatedAt, actor: "Guest", action: stillHeld ? "Deposit paid" : "Deposit arrived after the table was released", version: current.version, fields: stillHeld ? ["payment"] : ["status", "payment"], state: auditState(current) }];
    return current;
  });
  if (tableGone) {
    await refundDeposit(record.date, id, record.payment.intentId, "System", now);
    throw new BookingError("Your table was released before the deposit arrived. You have been refunded in full. Please book again.", 409);
  }
  return next || record;
}
/** Return a deposit through the provider. If the provider refuses, the record says so for staff to resolve. */
async function refundDeposit(date: string, id: string, intentId: string, actor: string, now = new Date()) {
  try {
    if (!paymentAdapter) throw new Error("No payment adapter");
    await paymentAdapter.refund(intentId);
    return await setPayment(date, id, { status: "refunded", settledAt: now.toISOString(), refundFailed: false }, "Deposit refunded", actor, now);
  } catch {
    console.error("[openres] deposit refund failed");
    return await setPayment(date, id, { refundFailed: true }, "Deposit refund failed", actor, now);
  }
}
/**
 * Settle the deposit after a booking ends. A completed visit applies it to the bill; a no-show
 * forfeits it; a cancellation refunds it unless the guest cancelled after the cutoff they were
 * shown when they booked. A venue cancelling always refunds.
 */
export async function settleDeposit(id: string, now = new Date()): Promise<Reservation | null> {
  const record = await readReservation(id);
  if (!record?.payment) return record;
  const { payment } = record;
  if (payment.status === "pending" && record.status === "cancelled") return (await releaseUnpaid(record.date, id, "Booking cancelled before the deposit was paid", now)) || record;
  if (payment.status !== "paid") return record;
  const settledAt = now.toISOString();
  if (record.status === "completed") return (await setPayment(record.date, id, { status: "applied", settledAt }, "Deposit applied to the bill", "System", now)) || record;
  if (record.status === "no_show") return (await setPayment(record.date, id, { status: "forfeited", settledAt }, "Deposit kept: no-show", "System", now)) || record;
  if (record.status !== "cancelled") return record;
  const byGuest = record.history.at(-1)?.actor === "Guest";
  if (byGuest && now.getTime() > Date.parse(payment.refundableUntil))
    return (await setPayment(record.date, id, { status: "forfeited", settledAt }, "Deposit kept: cancelled after the refund cutoff", "System", now)) || record;
  return (await refundDeposit(record.date, id, payment.intentId, byGuest ? "Guest" : "System", now)) || record;
}
/** A manager returns a deposit that was paid or kept, whatever the policy says. */
export async function refundDepositNow(id: string, actor: string, now = new Date()) {
  const record = await readReservation(id);
  if (!record?.payment) throw new BookingError("This reservation has no deposit.", 404);
  if (!["paid", "forfeited"].includes(record.payment.status)) throw new BookingError("This deposit cannot be refunded.", 409);
  const next = await refundDeposit(record.date, id, record.payment.intentId, actor, now);
  if (next?.payment?.status !== "refunded") throw new BookingError("The payment provider refused the refund. Resolve it with the provider.", 502);
  return next;
}
const depositsChecked = new Map<string, number>();
/**
 * Clear bookings on one date whose time to pay has run out. The provider is asked first: a guest
 * who paid but never returned to the page is confirmed, not cancelled. At most once a minute per
 * date and server instance; called from desk reads.
 */
export async function settleLapsedDeposits(date: string, now = new Date(), force = false) {
  if (!force) {
    if (now.getTime() - (depositsChecked.get(date) || 0) < 60000) return;
    if (depositsChecked.size > 64) depositsChecked.clear();
    depositsChecked.set(date, now.getTime());
  }
  try {
    const lapsed = (await readReservations(date)).filter((r) => r.status === "confirmed" && depositLapsed(r, now));
    for (const record of lapsed) {
      try {
        await confirmPayment(record.id, now);
      } catch (error) {
        // 402: not paid. 409: paid too late and refunded. Anything else: leave it for the next pass.
        if (error instanceof BookingError && error.status === 402) await releaseUnpaid(date, record.id, "Deposit not completed in time", now);
      }
    }
  } catch (error) {
    console.error("[openres] deposit pass failed", error instanceof Error ? error.name : "UnknownError");
  }
}
