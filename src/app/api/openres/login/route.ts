import { cookies } from 'next/headers';
import { z } from 'zod';
import { body, handle, json } from '@/lib/openres/http';
import { requestClientKey, SESSION_COOKIE, SESSION_SECONDS, signIn } from '@/lib/openres/auth';
export async function POST(request: Request) {
  return handle(async () => {
    const input = z.object({ username: z.string().trim().min(2).max(64), password: z.string().min(1).max(1024) }).parse(await body(request));
    const token = await signIn(input.username, input.password, requestClientKey(request));
    (await cookies()).set(SESSION_COOKIE, token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/', maxAge: SESSION_SECONDS });
    return json({ signedIn: true });
  });
}
