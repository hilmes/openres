import { z } from "zod";
import { venue } from '@/config/venue';
import { wallTimeToISO } from './time';
export const AREAS: Record<string, string> = venue.areas;
export type Area = string;
export const TABLES = venue.tables;
export const STATUSES = [
  "confirmed",
  "arrived",
  "seated",
  "completed",
  "cancelled",
  "no_show",
  "waitlisted",
] as const;
export type Status = (typeof STATUSES)[number];
export const STATUS_LABEL: Record<Status, string> = {
  confirmed: "Confirmed",
  arrived: "Arrived",
  seated: "Seated",
  completed: "Completed",
  cancelled: "Cancelled",
  no_show: "No-show",
  waitlisted: "Waitlist",
};
export type Reservation = {
  id: string;
  /** Internal retry proof; never include in guest projections. */
  requestKeyHash?: string;
  date: string;
  time: string;
  partySize: number;
  area: Area | "any";
  tableId: string | null;
  duration: number;
  name: string;
  email: string;
  phone: string;
  notes: string;
  staffNotes: string;
  occasion: string;
  status: Status;
  source: "online" | "phone" | "walk_in";
  createdAt: string;
  updatedAt: string;
  version: number;
  history: {
    at: string;
    actor: string;
    action: string;
    version?: number;
    fields?: string[];
    state?: {
      date: string;
      time: string;
      partySize: number;
      tableId: string | null;
      status: Status;
    };
    matchSource?: string;
  }[];
  provenance?: {
    system: "OpenRes";
    environment: "local_preview" | "live";
    createdBy: "guest" | "staff";
    actor: string;
    recordedAt: string;
    floorPlan: string;
    floorPlanRevision: string;
    match: {
      source:
        | "calendar_feed"
        | "sample_fixture"
        | "supplied_fixture"
        | "match_request"
        | "no_preference";
      sourceId?: string;
      reference?: string;
      capturedAt?: string;
      recordedAt: string;
    };
  };
  match: MatchPreference;
};
export type VisitSummary = {
  completedVisits: number;
  lastVisit: string | null;
  matchedBy: "email" | "phone" | null;
};
export type VisitHistory = Pick<
  Reservation,
  "id" | "name" | "date" | "time" | "partySize" | "status"
> & { guestKey: string };
export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const d = new Date(`${value}T12:00:00Z`);
    return (
      Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value
    );
  }, "Choose a valid date");
export const timeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const areaSchema = z.string().refine((value) => value === "any" || Object.hasOwn(AREAS, value), "Choose a valid seating area");
export const fixtureSchema = z.object({
  id: z.string().min(1).max(300),
  date: dateSchema,
  time: timeSchema,
  home: z.string().trim().min(1).max(120),
  away: z.string().trim().min(1).max(120),
  competition: z.string().max(120),
  proof: z.string().max(120).optional(),
});
export type BookingFixture = z.infer<typeof fixtureSchema>;
export const matchPreferenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("fixture"), fixture: fixtureSchema }),
  z.object({
    kind: z.literal("other"),
    request: z
      .string()
      .trim()
      .min(2, "Enter the match you want to watch")
      .max(240),
  }),
  z.object({ kind: z.literal("none") }),
]);
export type MatchPreference = z.infer<typeof matchPreferenceSchema>;
export function matchLabel(match?: MatchPreference) {
  return !match || match.kind === "none"
    ? "No match preference"
    : match.kind === "other"
      ? `Requested: ${match.request}`
      : `${match.fixture.home} vs ${match.fixture.away}`;
}
export function matchRequestValue(match?: MatchPreference) {
  return !match || match.kind === "none"
    ? ""
    : match.kind === "other"
      ? match.request
      : `${match.fixture.home} vs ${match.fixture.away}`;
}
export function editedMatchPreference(
  current: MatchPreference | undefined,
  value: string,
): MatchPreference {
  const request = value.trim();
  if (!request) return { kind: "none" };
  return current && request === matchRequestValue(current)
    ? current
    : { kind: "other", request };
}
export const bookingSchema = z.object({
  id: z.string().uuid(),
  date: dateSchema,
  time: timeSchema,
  partySize: z.number().int().min(1).max(8),
  area: areaSchema.default("any"),
  name: z.string().trim().min(2).max(100),
  email: z
    .string()
    .trim()
    .email()
    .max(254)
    .transform((s) => s.toLowerCase()),
  phone: z
    .union([
      z
        .string()
        .trim()
        .min(7)
        .max(32)
        .regex(/^[+\d() .-]+$/)
        .refine((s) => s.replace(/\D/g, "").length >= 7),
      z.literal(""),
    ])
    .default(""),
  notes: z.string().trim().max(1000).default(""),
  occasion: z.string().trim().max(80).default(""),
  website: z.string().max(0).optional(),
  match: matchPreferenceSchema.default({ kind: "none" }),
});
export type BookingInput = z.infer<typeof bookingSchema>;
export const settingsSchema = z.object({
  enabled: z.boolean(),
  duration: z.number().int().min(45).max(240).multipleOf(15),
  advanceDays: z.number().int().min(1).max(90),
  leadMinutes: z.number().int().min(0).max(1440),
  disabledTables: z
    .array(z.string().refine((id) => TABLES.some((t) => t.id === id)))
    .max(TABLES.length),
  hours: z
    .array(
      z
        .object({
          open: z.number().int().min(0).max(1410).multipleOf(30),
          close: z.number().int().min(30).max(1440).multipleOf(30),
          closed: z.boolean(),
        })
        .refine(
          (v) => v.closed || v.close > v.open,
          "Closing must be after opening",
        ),
    )
    .length(7),
  closedDates: z.array(dateSchema).max(365),
  version: z.number().int().min(1),
});
export type Settings = z.infer<typeof settingsSchema>;
// Bookable service windows, Sunday first. Managers can change them before opening intake.
export const DEFAULT_SETTINGS: Settings = {
  enabled: false,
  duration: 90,
  advanceDays: 30,
  leadMinutes: 30,
  disabledTables: [],
  closedDates: [],
  version: 1,
  hours: Array.from({ length: 7 }, () => ({
    open: 660,
    close: 1380,
    closed: false,
  })),
};
export class BookingError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export function venueNow(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: venue.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (key: string) => parts.find((p) => p.type === key)!.value;
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
  };
}
export function addDays(date: string, amount: number) {
  return new Date(Date.parse(`${date}T12:00:00Z`) + amount * 86400000)
    .toISOString()
    .slice(0, 10);
}
export function minutes(time: string) {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}
export function timeString(value: number) {
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}
export function timeLabel(time: string) {
  const [h, m] = time.split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
}
export function dateLabel(date: string) {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}
export function serviceHours(date: string, settings: Settings) {
  return settings.hours[new Date(`${date}T12:00:00Z`).getUTCDay()];
}
export function validateSlot(
  input: Pick<BookingInput, "date" | "time">,
  settings: Settings,
  now = new Date(),
  staff = false,
) {
  try {
    wallTimeToISO(input.date, input.time, venue.timeZone);
  } catch {
    throw new BookingError("Choose an unambiguous venue date and time.");
  }
  const today = venueNow(now);
  const h = serviceHours(input.date, settings);
  if (
    input.date < today.date ||
    input.date > addDays(today.date, settings.advanceDays)
  )
    throw new BookingError("Choose a date within the booking window.");
  if (h.closed || settings.closedDates.includes(input.date))
    throw new BookingError("Reservations are closed for this date.");
  const start = minutes(input.time);
  if (start % 15 !== 0 || start < h.open || start + settings.duration > h.close)
    throw new BookingError("Choose a time during bookable service hours.");
  if (
    input.date === today.date &&
    start < today.minutes + (staff ? -15 : settings.leadMinutes)
  )
    throw new BookingError("That time has passed. Please choose a later time.");
}
export function availableTables(
  input: Pick<BookingInput, "date" | "time" | "partySize" | "area">,
  reservations: Reservation[],
  settings: Settings,
  ignoreId?: string,
  now = new Date(),
  duration = settings.duration,
) {
  const start = minutes(input.time),
    end = start + duration;
  const clock = venueNow(now);
  return TABLES.filter(
    (t) =>
      t.seats >= input.partySize &&
      !settings.disabledTables.includes(t.id) &&
      (input.area === "any" || input.area === t.area),
  )
    .filter(
      (t) =>
        !reservations.some((r) => {
          if (
            r.id === ignoreId ||
            r.tableId !== t.id ||
            !["confirmed", "arrived", "seated"].includes(r.status)
          )
            return false;
          if (r.date !== input.date)
            return r.status === "seated" && r.date < input.date;
          const occupiedUntil =
            r.status === "seated" && r.date <= clock.date
              ? Math.max(
                  minutes(r.time) + r.duration,
                  r.date === clock.date ? clock.minutes + 15 : 1440,
                )
              : minutes(r.time) + r.duration;
          return start < occupiedUntil && end > minutes(r.time);
        }),
    )
    .sort((a, b) => a.seats - b.seats || Number(a.id) - Number(b.id));
}
export function availability(
  date: string,
  partySize: number,
  area: Area | "any",
  reservations: Reservation[],
  settings: Settings,
  now = new Date(),
  ignoreId?: string,
) {
  if (!settings.enabled) return [];
  const hours = serviceHours(date, settings);
  const slots: { time: string; areas: Area[] }[] = [];
  for (
    let start = hours.open;
    start + settings.duration <= hours.close;
    start += 15
  ) {
    const input = { date, time: timeString(start), partySize, area };
    try {
      validateSlot(input, settings, now);
    } catch {
      continue;
    }
    const tables = availableTables(
      input,
      reservations,
      settings,
      ignoreId,
      now,
    );
    if (tables.length)
      slots.push({
        time: input.time,
        areas: [...new Set(tables.map((t) => t.area))],
      });
  }
  return slots;
}
export const TRANSITIONS: Record<Status, Status[]> = {
  confirmed: ["arrived", "seated", "cancelled", "no_show"],
  arrived: ["seated", "cancelled", "no_show"],
  seated: ["completed"],
  completed: [],
  cancelled: [],
  no_show: [],
  waitlisted: ["confirmed", "seated", "cancelled"],
};
export function guestReservation(r: Reservation) {
  return {
    id: r.id,
    date: r.date,
    time: r.time,
    partySize: r.partySize,
    area: r.area,
    duration: r.duration,
    name: r.name,
    email: r.email,
    phone: r.phone,
    notes: r.notes,
    occasion: r.occasion,
    status: r.status,
    source: r.source,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    version: r.version,
    match: r.match || ({ kind: "none" } as MatchPreference),
  };
}
export type GuestReservation = ReturnType<typeof guestReservation>;
