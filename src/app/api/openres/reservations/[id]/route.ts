import { BookingError, guestReservation } from "@/lib/openres/model";
import { body, guestAccess, handle, json } from "@/lib/openres/http";
import { readReservation } from "@/lib/openres/store";
import { advanceWaitlist, updateReservation } from "@/lib/openres/service";
import { sendOfferEmail, sendReservationEmail } from "@/lib/openres/email";
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  return handle(async () => {
    const { id } = await context.params;
    guestAccess(request, id);
    const reservation = await readReservation(id);
    if (!reservation) throw new BookingError("Reservation not found.", 404);
    return json({ reservation: guestReservation(reservation) });
  });
}
export async function PATCH(request: Request, context: Context) {
  return handle(async () => {
    const { id } = await context.params;
    guestAccess(request, id);
    const reservation = await updateReservation(id, await body(request));
    const emailed = await sendReservationEmail(reservation);
    // A guest cancelling or moving may have freed a table for the waitlist.
    await Promise.all((await advanceWaitlist(reservation.date)).map(sendOfferEmail));
    return json({ reservation: guestReservation(reservation), emailed });
  });
}
