import { randomUUID } from 'node:crypto';
export async function security(c) {
  const { assert, client, request, login, check, day, manager, host, settings, base, password } = c;
  const guestInput = (overrides = {}) => ({ id: randomUUID(), requestKey: randomUUID(), date: day, time: '18:00', partySize: 2, name: 'Synthetic Guest', email: `${randomUUID()}@example.com`, phone: '', notes: 'Private synthetic seating note', ...overrides });
  c.guestInput = guestInput;
  await check('production refuses demo authorization and anonymous staff APIs', async () => {
    assert.equal((await request('/staff')).status, 307);
    for (const [path, method] of [['desk', 'GET'], ['desk', 'POST'], ['desk', 'PATCH'], ['settings', 'PUT'], ['export', 'GET']]) {
      assert.equal((await request(`/api/openres/${path}`, { method, ...(method !== 'GET' ? { body: {} } : {}) })).status, 401);
    }
    assert.equal((await request('/api/openres/desk', { cookie: `openres-session=${'x'.repeat(43)}` })).status, 401);
  });
  await check('staff cookies are Secure, HttpOnly, SameSite Strict with bounded lifetime', async () => {
    for (const part of ['Secure', 'HttpOnly', 'SameSite=strict', 'Max-Age=28800', 'Path=/']) assert(manager.header.toLowerCase().includes(part.toLowerCase()), part);
  });
  await check('staff cannot access manager history, exports or settings mutation', async () => {
    assert.equal((await request('/api/openres/desk?view=guests', { cookie: host.cookie })).status, 403);
    assert.equal((await request('/api/openres/export', { cookie: host.cookie })).status, 403);
    assert.equal((await request('/api/openres/settings', { method: 'PUT', cookie: host.cookie, body: settings })).status, 403);
  });
  await check('online intake starts disabled and only a manager can enable it', async () => {
    assert.equal((await request('/api/openres/reservations', { method: 'POST', body: guestInput() })).status, 503);
    const enabled = await request('/api/openres/settings', { method: 'PUT', cookie: manager.cookie, body: settings });
    assert.equal(enabled.status, 200); c.settings = enabled.data.settings;
  });
  await check('CSRF and cross-origin login/booking/settings/lock are rejected', async () => {
    for (const path of ['login', 'reservations', 'desk', 'lock']) {
      assert.equal((await request(`/api/openres/${path}`, { method: 'POST', cookie: manager.cookie, headers: { Origin: 'https://attacker.example' }, body: {} })).status, 403);
    }
    assert.equal((await request('/api/openres/settings', { method: 'PUT', cookie: manager.cookie, headers: { Origin: base, 'Sec-Fetch-Site': 'cross-site' }, body: settings })).status, 403);
  });
  await check('JSON validation rejects oversized, malformed and invalid booking input', async () => {
    const post = (body, headers) => request('/api/openres/reservations', { method: 'POST', body, headers });
    assert.equal((await post('{')).status, 400);
    assert.equal((await post({ notes: 'x'.repeat(17000) })).status, 413);
    assert.equal((await post('{}', { 'Content-Type': 'text/plain' })).status, 415);
    for (const changes of [{ date: '2026-02-31' }, { partySize: -1 }, { partySize: 100 }, { email: 'invalid' }, { website: 'spam' }, { notes: 'x'.repeat(1001) }]) assert.equal((await post(guestInput(changes))).status, 400);
    assert.equal((await request('/api/openres/availability?partySize=100')).status, 400);
  });
  const input = guestInput();
  const created = await request('/api/openres/reservations', { method: 'POST', body: input });
  assert.equal(created.status, 201); c.created = created.data; c.input = input;
  const path = `/api/openres/reservations/${input.id}`;
  const headers = { Authorization: `Bearer ${created.data.token}` };
  await check('guest capability is required and bound to a single reservation', async () => {
    assert.equal((await request(path)).status, 401);
    assert.equal((await request(path, { headers: { Authorization: `Bearer ${created.data.token}x` } })).status, 401);
    assert.equal((await request(`/api/openres/reservations/${randomUUID()}`, { headers })).status, 401);
    assert.equal((await request(path, { headers })).status, 200);
  });
  await check('guest cannot escalate status, assign tables or write staff notes', async () => {
    for (const change of [{ status: 'seated' }, { tableId: '11' }, { staffNotes: 'Unauthorized' }]) assert.equal((await request(path, { method: 'PATCH', headers, body: { version: 1, ...change } })).status, 403);
    for (const privateField of ['staffNotes', 'history', 'provenance', 'requestKeyHash']) assert(!(privateField in created.data.reservation));
    assert.equal(created.data.emailed, false);
  });
  await check('idempotent retries require a separate private request key', async () => {
    const { requestKey, ...withoutKey } = input;
    const replay = await request('/api/openres/reservations', { method: 'POST', body: withoutKey });
    assert([400, 409].includes(replay.status), 'Record ID and contact details recovered a management token');
    const wrong = await request('/api/openres/reservations', { method: 'POST', body: { ...input, requestKey: randomUUID() } });
    assert.equal(wrong.status, 409);
    const retry = await request('/api/openres/reservations', { method: 'POST', body: input });
    assert.equal(retry.status, 200); assert.equal(retry.data.token, created.data.token);
  });
  await check('public creation cannot impersonate a staff source or supply staff fields', async () => {
    const result = await request('/api/openres/reservations', { method: 'POST', body: guestInput({ source: 'walk_in', staffNotes: 'Forged', status: 'seated', tableId: 'missing' }) });
    assert.equal(result.status, 201); assert.equal(result.data.reservation.status, 'confirmed'); assert.equal(result.data.reservation.source, 'online');
  });
  await check('optimistic versions reject stale guest changes', async () => {
    const changed = await request(path, { method: 'PATCH', headers, body: { version: 1, notes: 'Updated private synthetic note' } });
    assert.equal(changed.status, 200);
    assert.equal((await request(path, { method: 'PATCH', headers, body: { version: 1, status: 'cancelled' } })).status, 409);
  });
  await check('SQL and markup payloads stay data, with no privileged fields in public responses', async () => {
    const attack = guestInput({ name: "<img src=x onerror=alert(1)>", notes: "'; DROP TABLE openres_reservations; --", waitlist: true });
    const result = await request('/api/openres/reservations', { method: 'POST', body: attack });
    assert.equal(result.status, 201); assert.equal(result.data.reservation.name, attack.name);
    assert((await client.query('SELECT COUNT(*)::int AS count FROM openres_reservations')).rows[0].count >= 3);
    const publicPage = await request('/book'); assert(!publicPage.text.includes(attack.name));
  });
  await check('manager history and CSV exclude contacts/notes and audit accesses', async () => {
    const formula = await request('/api/openres/desk', { method: 'POST', cookie: manager.cookie, body: guestInput({ name: '=1+1', waitlist: true }) });
    assert.equal(formula.status, 201);
    const history = await request('/api/openres/desk?view=guests', { cookie: manager.cookie });
    const csv = await request(`/api/openres/export?date=${day}`, { cookie: manager.cookie });
    assert.equal(history.status, 200); assert.equal(csv.status, 200);
    for (const response of [history, csv]) { assert(!response.text.includes(input.email)); assert(!response.text.includes(input.notes)); }
    assert(csv.text.includes('"\'=1+1"'));
    const actions = (await client.query('SELECT action FROM openres_access_audit')).rows.map(r => r.action);
    assert(actions.includes('guest_history_view')); assert(actions.includes('reservation_export'));
  });
  await check('staff see venue-only repeat counts without receiving historical contact records', async () => {
    const past = { ...created.data.reservation, id: randomUUID(), date: '2025-01-01', status: 'completed', notes: 'Historical-only private note', staffNotes: 'Historical-only staff note' };
    await client.query('INSERT INTO openres_reservations VALUES ($1,$2,$3,$4)', [past.id, past.date, past.email, JSON.stringify(past)]);
    const desk = await request(`/api/openres/desk?date=${day}`, { cookie: host.cookie });
    assert.equal(desk.status, 200);
    assert.deepEqual(desk.data.visitSummaries[input.id], { completedVisits: 1, lastVisit: '2025-01-01', matchedBy: 'email' });
    assert(!desk.text.includes('Historical-only'));
    assert(!desk.data.reservations.some(r => r.id === past.id));
    const guest = await request(path, { headers });
    assert(!('visitSummaries' in guest.data));
    assert(!('visitSummary' in guest.data.reservation));
  });
  await check('sensitive responses disable caching and provide protective headers', async () => {
    for (const result of [await request(path, { headers }), await request('/api/openres/desk', { cookie: host.cookie })]) {
      assert(result.headers.get('cache-control').includes('no-store'));
      assert.equal(result.headers.get('referrer-policy'), 'no-referrer');
      assert.equal(result.headers.get('x-content-type-options'), 'nosniff');
      assert(!result.headers.has('access-control-allow-origin'));
    }
    assert.equal((await request('/book')).headers.get('x-frame-options'), 'SAMEORIGIN');
  });
  await check('database stores staff session hashes, and lock revokes replayed cookies', async () => {
    const session = await login('host');
    const rawToken = session.cookie.split('=')[1];
    assert(!JSON.stringify((await client.query('SELECT * FROM openres_sessions')).rows).includes(rawToken));
    assert.equal((await request('/api/openres/lock', { method: 'POST', cookie: session.cookie, body: {} })).status, 200);
    assert.equal((await request('/api/openres/desk', { cookie: session.cookie })).status, 401);
  });
  await check('expired staff sessions cannot access the service book', async () => {
    const session = await login('host');
    await client.query("UPDATE openres_sessions SET expires=0 WHERE user_id LIKE 'host:%'");
    assert.equal((await request('/api/openres/desk', { cookie: session.cookie })).status, 401);
  });
  await check('login rate limits cannot be bypassed by spoofing forwarded IPs', async () => {
    await client.query('DELETE FROM openres_limits');
    for (let i = 0; i < 10; i++) assert.equal((await request('/api/openres/login', { method: 'POST', headers: { 'X-Forwarded-For': `192.0.2.${i}` }, body: { username: 'host', password: 'incorrect-synthetic-password' } })).status, 401);
    assert.equal((await request('/api/openres/login', { method: 'POST', body: { username: 'host', password } })).status, 429);
    await client.query('DELETE FROM openres_limits');
  });
  await check('failed booking attempts consume the booking rate limit', async () => {
    await client.query('DELETE FROM openres_limits');
    const current = (await request('/api/openres/desk', { cookie: manager.cookie })).data.settings;
    await request('/api/openres/settings', { method: 'PUT', cookie: manager.cookie, body: { ...current, closedDates: [day] } });
    const statuses = [];
    for (let i = 0; i < 9; i++) statuses.push((await request('/api/openres/reservations', { method: 'POST', body: guestInput(), headers: { 'X-Forwarded-For': `192.0.2.${i}` } })).status);
    assert.equal(statuses.at(-1), 429, 'Rejected bookings do not consume the limit');
  });
  // Reset only the isolated test inventory. Preserve manager authentication for benchmarks.
  await client.query('TRUNCATE openres_reservations, openres_limits');
  const current = (await request('/api/openres/desk', { cookie: manager.cookie })).data.settings;
  const active = await request('/api/openres/settings', { method: 'PUT', cookie: manager.cookie, body: { ...current, closedDates: [], disabledTables: ['12', '13', '14', '15', '16', '21', '31'] } });
  assert.equal(active.status, 200);
  await check('availability reads do not queue behind the inventory write lock', async () => {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(73632901)');
    try {
      const result = await request(`/api/openres/availability?date=${day}&partySize=2`, { signal: AbortSignal.timeout(1500) });
      assert.equal(result.status, 200);
    } finally { await client.query('ROLLBACK'); }
  });
  await check('12 simultaneous requests allocate the last table exactly once', async () => {
    const results = await Promise.all(Array.from({ length: 12 }, () => request('/api/openres/desk', { method: 'POST', cookie: manager.cookie, body: guestInput() })));
    assert.equal(results.filter(r => r.status === 201).length, 1);
    assert.equal(results.filter(r => r.status === 409).length, 11);
    assert.equal((await client.query('SELECT COUNT(*)::int AS count FROM openres_reservations')).rows[0].count, 1);
  });
  await check('availability excludes booked inventory and preserves seated overstays across dates', async () => {
    const available = async () => {
      const result = await request(`/api/openres/availability?date=${day}&partySize=2`);
      assert.equal(result.status, 200);
      return result.data.slots;
    };
    assert(!(await available()).some(slot => slot.time === '18:00'));
    await client.query("UPDATE openres_reservations SET service_date='2025-01-01', payload=payload || $1::jsonb", [JSON.stringify({ date: '2025-01-01', status: 'seated' })]);
    assert.equal((await available()).length, 0, 'An uncompleted seated overstay must still block its table');
    await client.query("UPDATE openres_reservations SET payload=payload || $1::jsonb", [JSON.stringify({ status: 'completed' })]);
    assert((await available()).some(slot => slot.time === '18:00'), 'Completing the prior visit must release its table');
  });
  const finalSettings = (await request('/api/openres/desk', { cookie: manager.cookie })).data.settings;
  await request('/api/openres/settings', { method: 'PUT', cookie: manager.cookie, body: { ...finalSettings, disabledTables: [] } });
}
