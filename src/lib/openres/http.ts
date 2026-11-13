import "server-only";
import { NextResponse } from "next/server";
import { z } from "zod";
import { currentStaff } from './auth';
import { BookingError } from "./model";
import { localMode } from "./store";
import { verifyManagementToken } from "./service";

export function json(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex, nofollow",
      "Referrer-Policy": "no-referrer",
    },
  });
}
export async function handle(action: () => Promise<Response>) {
  try {
    return await action();
  } catch (error) {
    if (error instanceof z.ZodError)
      return json(
        {
          error: error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; "),
        },
        400,
      );
    if (error instanceof BookingError)
      return json({ error: error.message }, error.status);
    // Never log request bodies, management tokens, or database connection strings.
    console.error(
      "[openres] request failed",
      error instanceof Error ? error.name : "UnknownError",
    );
    return json(
      {
        error:
          "OpenRes is temporarily unavailable. Please try again or contact the venue.",
      },
      503,
    );
  }
}
export async function body(request: Request) {
  const origin = request.headers.get("origin");
  // Next can reconstruct request.url with its internal listener hostname.
  // Compare browser requests with the public deployment origin, or the actual
  // HTTP Host in local development. Never trust forwarded-host headers here.
  const publicUrl = new URL(request.url);
  if (request.headers.get("host")) publicUrl.host = request.headers.get("host")!;
  const expectedOrigin = !localMode() && process.env.OPENRES_BASE_URL
    ? new URL(process.env.OPENRES_BASE_URL).origin
    : publicUrl.origin;
  if (
    request.headers.get("sec-fetch-site") === "cross-site" ||
    (origin && origin !== expectedOrigin)
  )
    throw new BookingError("Please submit this request from OpenRes.", 403);
  if (!request.headers.get("content-type")?.includes("application/json"))
    throw new BookingError("JSON is required.", 415);
  const reader = request.body?.getReader();
  if (!reader) throw new BookingError('JSON is required.');
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 16000) { await reader.cancel(); throw new BookingError('Request is too large.', 413); }
    chunks.push(value);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new BookingError("Invalid JSON.");
  }
}
export async function staffAccess(
  request: Request,
  manager = false,
): Promise<{ actor: string; manager: boolean } | Response> {
  if (
    localMode() &&
    ["localhost", "127.0.0.1", "[::1]"].includes(new URL(request.url).hostname)
  )
    return { actor: "Local preview", manager: true };
  const access = await currentStaff();
  if (!access) return json({ error: 'Sign in to the staff desk.' }, 401);
  if (manager && !access.manager) return json({ error: 'Manager access is required.' }, 403);
  return access;
}
export function guestAccess(request: Request, id: string) {
  if (!z.string().uuid().safeParse(id).success)
    throw new BookingError("Reservation not found.", 404);
  const token =
    request.headers.get("authorization")?.replace(/^Bearer /, "") || "";
  if (!verifyManagementToken(id, token))
    throw new BookingError(
      "This reservation link is invalid. Please use the full link from your confirmation.",
      401,
    );
}
