// @vitest-environment node
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
const jar = vi.hoisted(() => ({ token: '', deleted: false }));
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => jar.token ? { value: jar.token } : undefined, delete: () => { jar.deleted = true; jar.token = ''; } }) }));
import { hashPassword, verifyPassword } from './password';
import { currentStaff, signIn, signOut } from './auth';
import { readSettings } from './store';
const folder = mkdtempSync(join(tmpdir(), 'openres-auth-test-'));
const file = join(folder, 'test.sqlite');
let db: Database.Database;
let passwordHash: string;
beforeAll(async () => {
  vi.stubEnv('OPENRES_DEMO','1'); vi.stubEnv('OPENRES_SQLITE_PATH',file); vi.stubEnv('OPENRES_SEED','0'); vi.stubEnv('VERCEL','');
  vi.stubEnv('OPENRES_TOKEN_SECRET','test-only-secret-not-for-any-real-deployment');
  await readSettings(); db = new Database(file);
  passwordHash = await hashPassword('synthetic-test-password');
});
beforeEach(() => {
  db.exec('DELETE FROM openres_limits; DELETE FROM openres_sessions');
  jar.token = ''; jar.deleted = false;
  vi.stubEnv('OPENRES_STAFF_USERS', JSON.stringify([{ id:'host', role:'staff', passwordHash }, { id:'manager',role:'manager',passwordHash }]));
});
afterAll(() => { db.close(); vi.unstubAllEnvs(); rmSync(folder,{recursive:true,force:true}); });
it('verifies salted passwords and rejects invalid passwords', async () => {
  expect(await verifyPassword('synthetic-test-password',passwordHash)).toBe(true);
  expect(await verifyPassword('incorrect-password',passwordHash)).toBe(false);
  expect(await verifyPassword('password','malformed')).toBe(false);
});
it('stores only a token hash and revokes the session when the desk locks', async () => {
  jar.token = await signIn('host','synthetic-test-password','client-test');
  expect(await currentStaff()).toEqual({actor:'host',manager:false});
  const rows = db.prepare('SELECT * FROM openres_sessions').all();
  expect(JSON.stringify(rows)).not.toContain(jar.token);
  const oldToken = jar.token;
  await signOut(); expect(jar.deleted).toBe(true);
  jar.token = oldToken;
  expect(await currentStaff()).toBeNull();
});
it('honors expiration, role changes and removal on every request', async () => {
  jar.token = await signIn('manager','synthetic-test-password','client-test');
  expect((await currentStaff())?.manager).toBe(true);
  vi.stubEnv('OPENRES_STAFF_USERS', JSON.stringify([{id:'manager',role:'staff',passwordHash}]));
  expect((await currentStaff())?.manager).toBe(false);
  vi.stubEnv('OPENRES_STAFF_USERS', JSON.stringify([{id:'host',role:'staff',passwordHash}]));
  expect(await currentStaff()).toBeNull();
  jar.token = await signIn('host','synthetic-test-password','client-test');
  db.prepare('UPDATE openres_sessions SET expires = 0').run();
  expect(await currentStaff()).toBeNull();
});
it('rejects unknown users and limits repeated attempts before password work', async () => {
  await expect(signIn('nobody','synthetic-test-password','client-test')).rejects.toMatchObject({status:401});
  for(let i=0;i<10;i++) await expect(signIn('host','incorrect-password','client-test')).rejects.toMatchObject({status:401});
  await expect(signIn('host','synthetic-test-password','client-test')).rejects.toMatchObject({status:429});
}, 15000);
