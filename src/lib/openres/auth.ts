import 'server-only';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { cookies } from 'next/headers';
import { z } from 'zod';
import { BookingError } from './model';
import { consumeAuthLimit, deleteSession, recordAccessAudit, saveSession, sessionIdentity } from './store';
import { verifyPassword } from './password';
export const SESSION_COOKIE = 'openres-session';
export const SESSION_SECONDS = 8 * 60 * 60;
const usersSchema = z.array(z.object({
  id: z.string().regex(/^[a-z0-9_-]{2,64}$/),
  role: z.enum(['staff', 'manager']),
  passwordHash: z.string().regex(/^scrypt:32768:8:3:[a-f0-9]{64}:[a-f0-9]{128}$/),
})).min(1);
function users() {
  try {
    const configured = usersSchema.parse(JSON.parse(process.env.OPENRES_STAFF_USERS || '[]'));
    if (new Set(configured.map(u => u.id)).size !== configured.length) throw new Error('Duplicate IDs');
    return configured;
  } catch { throw new BookingError('Staff sign-in is not configured.', 503); }
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const identity = (user: { id: string; passwordHash: string }) => `${user.id}:${digest(user.passwordHash)}`;
export function requestClientKey(request: Request) {
  // Enable only behind a trusted reverse proxy that overwrites this header.
  return process.env.OPENRES_TRUST_PROXY === '1'
    ? (request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown')
    : 'unknown';
}
export async function signIn(username: string, password: string, clientKey: string) {
  const key = process.env.OPENRES_TOKEN_SECRET;
  if (!key || key.length < 32) throw new BookingError('Staff sign-in is not configured.', 503);
  const configured = users();
  const window = Math.floor(Date.now() / 900000);
  const expires = (window + 1) * 900000;
  const hash = (value: string) => createHmac('sha256', key).update(`openres:login:${value}`).digest('hex');
  await consumeAuthLimit(`login:ip:${window}:${hash(clientKey)}`, 30, expires);
  await consumeAuthLimit(`login:user:${window}:${hash(username.toLowerCase())}`, 10, expires);
  const user = configured.find(u => u.id === username.toLowerCase());
  // Unknown users perform the same password derivation to reduce account enumeration.
  const dummy = `scrypt:32768:8:3:${'0'.repeat(64)}:${'0'.repeat(128)}`;
  const valid = await verifyPassword(password, user?.passwordHash || dummy);
  if (!valid || !user) throw new BookingError('Incorrect username or password.', 401);
  const token = randomBytes(32).toString('base64url');
  await saveSession(digest(token), identity(user), Date.now() + SESSION_SECONDS * 1000);
  await recordAccessAudit(user.id, 'staff_sign_in', 'session');
  return token;
}
export async function currentStaff() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const value = await sessionIdentity(digest(token));
  if (!value) return null;
  // Role edits, account removal and password rotation take effect on the next request.
  const user = users().find(u => identity(u) === value);
  return user ? { actor: user.id, manager: user.role === 'manager' } : null;
}
export async function signOut() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  try { if (token) await deleteSession(digest(token)); }
  finally { jar.delete(SESSION_COOKIE); }
}
