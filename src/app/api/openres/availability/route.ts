import { z } from "zod";
import { paymentAdapter } from "@/config/payments";
import {
  availability,
  areaSchema,
  dateSchema,
  venueNow,
} from "@/lib/openres/model";
import { handle, json } from "@/lib/openres/http";
import { localMode, readAvailabilityInventory } from "@/lib/openres/store";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  return handle(async () => {
    const params = new URL(request.url).searchParams;
    const date = dateSchema.parse(params.get("date") || venueNow().date);
    const partySize = z.coerce
      .number()
      .int()
      .min(1)
      .max(8)
      .parse(params.get("partySize") || 2);
    const area = areaSchema.parse(params.get("area") || "any");
    const { settings, reservations } = await readAvailabilityInventory(date);
    const data = {
      slots: availability(date, partySize, area, reservations, settings),
      enabled: settings.enabled,
      advanceDays: settings.advanceDays,
      duration: settings.duration,
      // The rule, so the guest sees the deposit before entering their details.
      ...(settings.deposit?.enabled && paymentAdapter ? { deposit: { ...settings.deposit, currency: paymentAdapter.currency } } : {}),
    };
    return json({ ...data, date, partySize, local: localMode() });
  });
}
