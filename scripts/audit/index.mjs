import assert from 'node:assert/strict';
import { randomBytes, scryptSync } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { cpus, platform, arch } from 'node:os';
import { Client } from 'pg';
import { security } from './security.mjs';
import { performanceSuite } from './performance.mjs';

const databaseUrl = process.env.OPENRES_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('Set OPENRES_TEST_DATABASE_URL to a disposable loopback openres_test database.');
const parsed = new URL(databaseUrl);
if (!['127.0.0.1', 'localhost'].includes(parsed.hostname) || parsed.pathname !== '/openres_test') throw new Error('Refusing a non-loopback or non-test database.');
const port = 4030;
const base = `http://127.0.0.1:${port}`;
// Do not accidentally test a different process already listening on this port.
await new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once('error', () => reject(new Error('Port 4030 is unavailable; stop its owner or use a separate test environment.')));
  probe.listen(port, '127.0.0.1', () => probe.close(resolve));
});
const dir = '.openres/audit';
await mkdir(dir, { recursive: true });
const client = new Client({ connectionString: databaseUrl });
await client.connect();
await client.query(await readFile('migrations/001_initial.sql', 'utf8'));
const reset = () => client.query('TRUNCATE openres_reservations, openres_settings, openres_sessions, openres_limits, openres_access_audit');
await reset();
const password = randomBytes(24).toString('base64url');
const salt = randomBytes(32);
const passwordHash = `scrypt:32768:8:3:${salt.toString('hex')}:${scryptSync(password, salt, 64, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }).toString('hex')}`;
const log = createWriteStream(`${dir}/server.log`);
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '-p', String(port)], {
  env: { ...process.env, NODE_ENV: 'production', NEXT_BUILD_DIR: '.next-audit', NEXT_TELEMETRY_DISABLED: '1', DATABASE_URL: databaseUrl,
    OPENRES_BASE_URL: base, OPENRES_TOKEN_SECRET: randomBytes(48).toString('hex'), OPENRES_DEMO: '1', OPENRES_TRUST_PROXY: '0',
    OPENRES_STAFF_USERS: JSON.stringify(['host', 'manager'].map(id => ({ id, role: id === 'host' ? 'staff' : 'manager', passwordHash }))),
    RESEND_API_KEY: '', OPENRES_EMAIL_FROM: '',
  }, stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.pipe(log); server.stderr.pipe(log);
const checks = [];
const timings = [];
async function check(name, action) {
  try { await action(); checks.push({ name, passed: true }); console.log(`PASS ${name}`); }
  catch (error) { checks.push({ name, passed: false, error: error.message }); console.error(`FAIL ${name}: ${error.message}`); }
}
async function request(path, { method = 'GET', cookie, body, headers = {}, ...options } = {}) {
  const response = await fetch(base + path, { method, redirect: 'manual', signal: AbortSignal.timeout(30000), ...options,
    headers: { Origin: base, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
    ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, headers: response.headers, data, text };
}
async function login(username) {
  const result = await request('/api/openres/login', { method: 'POST', body: { username, password } });
  assert.equal(result.status, 200, 'Synthetic staff sign-in failed');
  return { cookie: result.headers.get('set-cookie').split(';')[0], header: result.headers.get('set-cookie') };
}
let report;
try {
  let ready = false;
  for (let i = 0; i < 60; i++) {
    if (server.exitCode !== null) throw new Error('Production server exited; inspect the local audit log.');
    try { if ((await request('/book')).status === 200) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert(ready, 'Production server failed to become ready');
  const day = new Date(Date.now() + 86400000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const manager = await login('manager');
  const host = await login('host');
  const settings = (await request('/api/openres/desk', { cookie: manager.cookie })).data.settings;
  settings.enabled = true;
  const context = { assert, client, request, login, check, timings, day, manager, host, settings, base, password };
  await security(context);
  await performanceSuite(context);
  report = {
    recordedAt: new Date().toISOString(), commit: process.env.OPENRES_AUDIT_COMMIT || process.env.GITHUB_SHA || 'working-tree',
    environment: { node: process.version, platform: platform(), architecture: arch(), cpu: cpus()[0]?.model, processors: cpus().length, database: 'disposable PostgreSQL on loopback', build: 'production', concurrency: 8 },
    checks, timings,
    limitations: ['Localhost timings include no internet/TLS latency.', 'No physical iPad, browser paint/INP or production-scale capacity measurement.', 'Synthetic records only. This suite is not an independent penetration test.'],
  };
  await writeFile(`${dir}/results.json`, JSON.stringify(report, null, 2) + '\n');
  console.table(timings);
  console.log(`${checks.filter(c => c.passed).length}/${checks.length} checks passed. Results: ${dir}/results.json`);
  if (checks.some(c => !c.passed)) process.exitCode = 1;
} finally {
  server.kill('SIGTERM');
  await Promise.race([once(server, 'exit'), new Promise(resolve => setTimeout(resolve, 3000))]);
  if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
  log.end(); await client.end();
}
