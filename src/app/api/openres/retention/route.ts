import { z } from "zod";
import { body, handle, json, staffAccess } from "@/lib/openres/http";
import { eraseGuest, purgeExpired } from "@/lib/openres/service";
const requestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("purge") }),
  z.object({ action: z.literal("erase"), id: z.string().uuid() }),
]);
/** Manager only: run the retention pass now, or erase one guest's details on request. */
export async function POST(request: Request) {
  return handle(async () => {
    const access = await staffAccess(request, true);
    if (access instanceof Response) return access;
    const input = requestSchema.parse(await body(request));
    return json(input.action === "purge" ? await purgeExpired(access.actor) : await eraseGuest(input.id, access.actor));
  });
}
