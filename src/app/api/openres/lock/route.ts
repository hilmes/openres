import { signOut } from '@/lib/openres/auth';
import { body, handle, json } from "@/lib/openres/http";
import { localMode } from "@/lib/openres/store";
export async function POST(request: Request) {
  return handle(async () => {
    await body(request);
    if (!localMode()) await signOut();
    return json({ locked: true });
  });
}
