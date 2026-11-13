import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
export async function performanceSuite(c) {
  const { assert, request, client, timings, day, manager, check } = c;
  const percentile = (values, percent) => values.slice().sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * percent) - 1)];
  async function benchmark(name, action, count = 40, concurrency = 8, budget = 1000) {
    for (let i = 0; i < 3; i++) assert.equal((await action()).status, 200);
    const samples = []; let failures = 0; let next = 0;
    const start = performance.now();
    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (next++ < count) {
        const began = performance.now();
        try { if ((await action()).status !== 200) failures++; } catch { failures++; }
        samples.push(performance.now() - began);
      }
    }));
    const elapsed = performance.now() - start;
    const result = { name, requests: count, concurrency, p50_ms: +percentile(samples, .5).toFixed(1), p95_ms: +percentile(samples, .95).toFixed(1), max_ms: +Math.max(...samples).toFixed(1), requests_per_second: +(count / elapsed * 1000).toFixed(1), failures };
    timings.push(result);
    await check(`${name}: no errors; p95 under ${budget}ms (local regression budget)`, async () => { assert.equal(failures, 0); assert(result.p95_ms < budget, `p95 ${result.p95_ms}ms exceeds ${budget}ms`); });
  }
  await client.query('TRUNCATE openres_reservations, openres_limits');
  const avail = () => request(`/api/openres/availability?date=${day}&partySize=2`);
  await benchmark('availability_empty', avail);
  const now = new Date().toISOString();
  const seed = Array.from({ length: 5000 }, (_, i) => {
    const serviceDate = i < 400 ? day : '2025-01-01';
    return { id: randomUUID(), date: serviceDate, time: '18:00', partySize: 2, area: 'any', tableId: null, duration: 90, name: `Synthetic Guest ${i}`, email: `guest${i}@example.com`, phone: '', notes: 'Synthetic private note', staffNotes: 'Synthetic private staff note', occasion: '', status: i < 400 ? 'waitlisted' : 'completed', source: 'online', createdAt: now, updatedAt: now, version: 1, history: [], match: { kind: 'none' } };
  });
  await client.query('INSERT INTO openres_reservations(id,service_date,email,payload) SELECT r->>\'id\',r->>\'date\',r->>\'email\',r FROM jsonb_array_elements($1::jsonb) AS r', [JSON.stringify(seed)]);
  await benchmark('availability_400_service_5000_total', avail);
  await benchmark('staff_service_400', () => request(`/api/openres/desk?date=${day}`, { cookie: manager.cookie }));
  await benchmark('manager_history_5000', () => request('/api/openres/desk?view=guests', { cookie: manager.cookie }), 20, 4, 1500);
  await benchmark('guest_page', () => request('/book'));
  await benchmark('staff_page', () => request('/staff', { cookie: manager.cookie }));
  await check('guest page initial JS/CSS and fonts remain within local transfer budgets', async () => {
    const page = await request('/book');
    const assets = [...new Set([...page.text.matchAll(/(?:src|href)="([^" ]+\.(?:js|css)(?:\?[^" ]*)?)"/g)].map(m => m[1]).filter(p => p.startsWith('/_next/')))];
    let scriptBytes = 0; let styleBytes = 0;
    for (const path of assets) {
      const response = await request(path); assert.equal(response.status, 200);
      const compressed = gzipSync(Buffer.from(response.text)).byteLength;
      if (/\.js(?:\?|$)/.test(path)) scriptBytes += compressed; else styleBytes += compressed;
      assert(!/OPENRES_STAFF_USERS|OPENRES_TOKEN_SECRET|postgres:\/\//.test(response.text), 'Private server configuration name in client bundle');
    }
    const fonts = await Promise.all(['/fonts/archivo-latin.woff2', '/fonts/fragment-mono-latin.woff2'].map(async path => {
      const r = await fetch(c.base + path); assert.equal(r.status, 200); return (await r.arrayBuffer()).byteLength;
    }));
    timings.push({ name: 'guest_assets', js_gzip_kb: +(scriptBytes / 1024).toFixed(1), css_gzip_kb: +(styleBytes / 1024).toFixed(1), fonts_raw_kb: +(fonts.reduce((a, b) => a + b, 0) / 1024).toFixed(1) });
    assert(scriptBytes < 300 * 1024, `Initial JavaScript ${Math.round(scriptBytes / 1024)}KiB gzip exceeds 300KiB`);
    assert(fonts.reduce((a, b) => a + b, 0) < 250 * 1024, 'Fonts exceed 250KiB uncompressed transfer budget');
  });
}
