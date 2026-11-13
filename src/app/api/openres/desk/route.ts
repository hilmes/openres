import { z } from "zod";
import { body, handle, json, staffAccess } from "@/lib/openres/http";
import { dateSchema, venueNow } from "@/lib/openres/model";
import {
  readReservations,
  readVisitSummaries,
  readSettings,
  localMode,
  recordAccessAudit,
} from "@/lib/openres/store";
import {
  createReservation,
  updateReservation,
  visitHistory,
} from "@/lib/openres/service";
import { sendReservationEmail } from "@/lib/openres/email";
export async function GET(request: Request) {
  return handle(async () => {
    const params = new URL(request.url).searchParams;
    const access = await staffAccess(request, params.get("view") === "guests");
    if (access instanceof Response) return access;
    const date = dateSchema.parse(params.get("date") || venueNow().date);
    const [reservations, settings] = await Promise.all([
      readReservations(params.get("view") === "guests" ? undefined : date),
      readSettings(),
    ]);
    if (params.get("view") === "guests")
      await recordAccessAudit(
        access.actor,
        "guest_history_view",
        `records=${reservations.length}`,
      );
    return json({
      reservations: params.get("view") === "guests" ? [] : reservations,
      ...(params.get("view") === "guests"
        ? { visits: visitHistory(reservations) }
        : { visitSummaries: await readVisitSummaries(reservations) }),
      settings,
      manager: access.manager,
      local: localMode(),
    });
  });
}
export async function POST(request: Request) {
  return handle(async () => {
    const access = await staffAccess(request);
    if (access instanceof Response) return access;
    const result = await createReservation(await body(request), access.actor);
    const emailed = result.created
      ? await sendReservationEmail(result.reservation)
      : false;
    return json(
      { reservation: result.reservation, emailed },
      result.created ? 201 : 200,
    );
  });
}
export async function PATCH(request: Request) {
  return handle(async () => {
    const access = await staffAccess(request);
    if (access instanceof Response) return access;
    const raw = z
      .object({ id: z.string().uuid() })
      .passthrough()
      .parse(await body(request));
    const reservation = await updateReservation(raw.id, raw, access.actor);
    const guestChange =
      ["date", "time", "partySize", "area", "match"].some(
        (key) => key in raw,
      ) ||
      raw.status === "confirmed" ||
      raw.status === "cancelled";
    const emailed = guestChange
      ? await sendReservationEmail(reservation)
      : false;
    return json({ reservation, emailed });
  });
}
