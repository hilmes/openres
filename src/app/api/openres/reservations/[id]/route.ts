import { BookingError, guestReservation } from "@/lib/openres/model";
import { body, guestAccess, handle, json } from "@/lib/openres/http";
import { readReservation } from "@/lib/openres/store";
import { advanceWaitlist, confirmPayment, settleDeposit, updateReservation } from "@/lib/openres/service";
import { sendOfferEmail, sendReservationEmail } from "@/lib/openres/email";
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  return handle(async () => {
    const { id } = await context.params;
    guestAccess(request, id);
    let reservation = await readReservation(id);
    if (!reservation) throw new BookingError("Reservation not found.", 404);
    // A guest who paid but never got back to the confirmation page is caught up here.
    if (reservation.payment?.status === "pending") reservation = await confirmPayment(id).catch(() => reservation!);
    return json({ reservation: guestReservation(reservation) });
  });
}
/** The guest's browser reports that the provider's form finished. The server asks the provider itself before believing it. */
export async function POST(request: Request, context: Context) {
  return handle(async () => {
    const { id } = await context.params;
    guestAccess(request, id);
    await body(request);
    const before = await readReservation(id);
    const reservation = await confirmPayment(id);
    const emailed = before?.payment?.status === "pending" && reservation.payment?.status === "paid" ? await sendReservationEmail(reservation) : false;
    return json({ reservation: guestReservation(reservation), emailed });
  });
}
export async function PATCH(request: Request, context: Context) {
  return handle(async () => {
    const { id } = await context.params;
    guestAccess(request, id);
    const updated = await updateReservation(id, await body(request));
    // A cancellation refunds or keeps the deposit under the policy the guest was shown.
    const reservation = (updated.status === "cancelled" ? await settleDeposit(id) : null) || updated;
    const emailed = await sendReservationEmail(reservation);
    // A guest cancelling or moving may have freed a table for the waitlist.
    await Promise.all((await advanceWaitlist(reservation.date)).map(sendOfferEmail));
    return json({ reservation: guestReservation(reservation), emailed });
  });
}
