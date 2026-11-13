import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
const params = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, Buffer.from(salt, 'hex'), 64, params, (error, key) => error ? reject(error) : resolve(key)));
}
export async function hashPassword(password: string) {
  if (password.length < 12 || password.length > 1024) throw new Error('Use a password between 12 and 1024 characters');
  const salt = randomBytes(32).toString('hex');
  return `scrypt:32768:8:3:${salt}:${(await derive(password, salt)).toString('hex')}`;
}
export async function verifyPassword(password: string, hash: string) {
  const match = /^scrypt:32768:8:3:([a-f0-9]{64}):([a-f0-9]{128})$/.exec(hash);
  if (!match || password.length > 1024) return false;
  return timingSafeEqual(await derive(password, match[1]), Buffer.from(match[2], 'hex'));
}
