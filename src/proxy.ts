import { NextResponse, type NextRequest } from "next/server";
import { contentSecurityPolicy } from "@/lib/openres/csp";

/** Gives every page a fresh nonce and a Content Security Policy built around it. */
export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const policy = contentSecurityPolicy(nonce, {
    dev: process.env.NODE_ENV === "development",
    https: (process.env.OPENRES_BASE_URL || "").startsWith("https://"),
  });
  // Next.js reads the nonce from the request's copy of the header while rendering.
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", policy);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy", policy);
  return response;
}

export const config = {
  matcher: [
    {
      // Pages only. API responses are JSON or CSV and get a deny-all policy in next.config.ts.
      source: "/((?!api|_next/static|_next/image|fonts|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
