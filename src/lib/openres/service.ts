import "server-only";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { venue } from '@/config/venue';
const floorPlanRevision = createHash('sha256').update(JSON.stringify(venue.floor) + JSON.stringify(venue.tables)).digest('hex');
import {
  availableTables,
  BookingError,
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
  type VisitHistory,
} from "./model";
import { consumeAuthLimit, localMode, withInventory } from "./store";
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
      reservations.push(reservation);
      return { reservation, created: true };
    },
  );
  return { ...result, token };
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
        (input.status && input.status !== "cancelled"))
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
        );
        const table = input.tableId
          ? candidates.find((t) => t.id === input.tableId)
          : candidates.find((t) => t.id === record.tableId) || candidates[0];
        if (!table)
          throw new BookingError(
            "No suitable table is free for this visit. Choose another table or time.",
            409,
          );
        next.tableId = table.id;
      }
    }
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
