import { randomBytes, scryptSync } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
const terminal = createInterface({ input: process.stdin, output: process.stdout });
const id = (await terminal.question('Staff username (lowercase letters, digits, _ or -): ')).trim();
const role = (await terminal.question('Role (staff or manager): ')).trim();
terminal.close();
if (!/^[a-z0-9_-]{2,64}$/.test(id) || !['staff', 'manager'].includes(role)) throw new Error('Invalid username or role');
if (!process.stdin.isTTY) throw new Error('Run this command in an interactive terminal');
process.stdout.write('Password (input hidden): ');
process.stdin.setRawMode(true);
process.stdin.resume();
const password = await new Promise((resolve, reject) => {
  let value = '';
  function data(buffer) {
    for (const character of buffer.toString('utf8')) {
      if (character === '\u0003') { finish(); reject(new Error('Cancelled')); return; }
      if (character === '\r' || character === '\n') { finish(); resolve(value); return; }
      if (character === '\u007f' || character === '\b') value = value.slice(0, -1);
      else if (character >= ' ' && value.length <= 1024) value += character;
    }
  }
  function finish() { process.stdin.removeListener('data', data); process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write('\n'); }
  process.stdin.on('data', data);
});
if (password.length < 12 || password.length > 1024) throw new Error('Use 12–1024 characters');
const salt = randomBytes(32).toString('hex');
const key = scryptSync(password, Buffer.from(salt, 'hex'), 64, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }).toString('hex');
console.log('Add this object to your private OPENRES_STAFF_USERS JSON array:');
console.log(JSON.stringify({ id, role, passwordHash: `scrypt:32768:8:3:${salt}:${key}` }));
