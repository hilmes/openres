import { body, handle, json, staffAccess } from "@/lib/openres/http";
import { updateSettings } from "@/lib/openres/service";
export async function PUT(request: Request) {
  return handle(async () => {
    const access = await staffAccess(request, true);
    if (access instanceof Response) return access;
    return json({
      settings: await updateSettings(await body(request), access.actor),
    });
  });
}
