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
  advanceWaitlist,
  advanceWaitlistIfDue,
  createReservation,
  purgeIfDue,
  refundDepositNow,
  settleDeposit,
  settleLapsedDeposits,
  updateReservation,
  visitHistory,
} from "@/lib/openres/service";
import { sendOfferEmail, sendReservationEmail } from "@/lib/openres/email";
export async function GET(request: Request) {
  return handle(async () => {
    const params = new URL(request.url).searchParams;
    const access = await staffAccess(request, params.get("view") === "guests");
    if (access instanceof Response) return access;
    const date = dateSchema.parse(params.get("date") || venueNow().date);
    await purgeIfDue();
    // Unpaid bookings past their time to pay are released here (after asking the provider).
    if (params.get("view") !== "guests") await settleLapsedDeposits(date);
    // Lapsed waitlist offers pass to the next party here, so no scheduler is needed while a desk is open.
    if (params.get("view") !== "guests") await Promise.all((await advanceWaitlistIfDue(date)).map(sendOfferEmail));
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
    // Manager only: return a deposit that was paid or kept, whatever the policy says.
    if (raw.action === "refund_deposit") {
      if (!access.manager) return json({ error: "Manager access is required." }, 403);
      return json({ reservation: await refundDepositNow(raw.id, access.actor), emailed: false });
    }
    const updated = await updateReservation(raw.id, raw, access.actor);
    const reservation = (["cancelled", "no_show", "completed"].includes(updated.status) ? await settleDeposit(raw.id) : null) || updated;
    const guestChange =
      ["date", "time", "partySize", "area", "match"].some(
        (key) => key in raw,
      ) ||
      raw.status === "confirmed" ||
      raw.status === "cancelled";
    const emailed = guestChange
      ? await sendReservationEmail(reservation)
      : false;
    // A cancellation, no-show, completion or move may have freed a table for the waitlist.
    await Promise.all((await advanceWaitlist(reservation.date)).map(sendOfferEmail));
    return json({ reservation, emailed });
  });
}
