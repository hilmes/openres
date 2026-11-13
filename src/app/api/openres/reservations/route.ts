import { createReservation, requestRateKey } from "@/lib/openres/service";
import { guestReservation } from "@/lib/openres/model";
import { body, handle, json } from "@/lib/openres/http";
import { sendReservationEmail } from "@/lib/openres/email";
import { requestClientKey } from '@/lib/openres/auth';
export async function POST(request: Request) {
  return handle(async () => {
    const raw = await body(request);
    const ip = requestClientKey(request);
    const result = await createReservation(raw, undefined, requestRateKey(ip));
    const emailed = result.created
      ? await sendReservationEmail(result.reservation)
      : false;
    return json(
      {
        reservation: guestReservation(result.reservation),
        token: result.token,
        emailed,
      },
      result.created ? 201 : 200,
    );
  });
}
