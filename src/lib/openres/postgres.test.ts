// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
const jar=vi.hoisted(()=>({token:''}));
vi.mock('server-only',()=>({}));
vi.mock('next/headers',()=>({cookies:async()=>({get:()=>jar.token?{value:jar.token}:undefined,delete:()=>{jar.token='';}})}));
import { createReservation, updateSettings } from './service';
import { DEFAULT_SETTINGS, TABLES } from './model';
import { currentStaff, signIn, signOut } from './auth';
import { hashPassword } from './password';
import { readVisitSummaries } from './store';
const url=process.env.OPENRES_TEST_DATABASE_URL;
describe.skipIf(!url)('isolated PostgreSQL integration',()=>{
  let client:Client;
  let migration:string;
  const now=new Date('2026-11-13T12:00:00Z');
  beforeAll(async()=>{
    const parsed=new URL(url!);
    // These tests truncate tables: never allow a production host or database name.
    if(!['127.0.0.1','localhost'].includes(parsed.hostname)||parsed.pathname!=='/openres_test') throw new Error('Use a loopback openres_test database only');
    vi.stubEnv('OPENRES_DEMO','0');vi.stubEnv('DATABASE_URL',url!);
    vi.stubEnv('OPENRES_TOKEN_SECRET','isolated-postgres-test-secret-not-for-production');
    client=new Client({connectionString:url});await client.connect();
    migration=await readFile('migrations/001_initial.sql','utf8');
    await client.query(migration);
  });
  beforeEach(async()=>{
    await client.query('TRUNCATE openres_reservations, openres_settings, openres_limits, openres_sessions, openres_access_audit');
    jar.token='';
  });
  afterAll(async()=>{await client?.end();vi.unstubAllEnvs();});
  it('applies the migration repeatedly',async()=>{
    await client.query(migration);
    expect((await client.query("SELECT COUNT(*)::int AS count FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE 'openres_%'")).rows[0].count).toBe(5);
  });
  it('serializes two concurrent requests for the last table',async()=>{
    await updateSettings({...DEFAULT_SETTINGS,enabled:true,disabledTables:TABLES.filter(t=>t.id!=='11').map(t=>t.id)},'manager');
    const input=()=>({id:randomUUID(),requestKey:randomUUID(),date:'2026-11-14',time:'18:00',partySize:2,name:'Synthetic Guest',email:`${randomUUID()}@example.com`});
    const results=await Promise.allSettled([createReservation(input(),undefined,undefined,now),createReservation(input(),undefined,undefined,now)]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    expect((await client.query('SELECT COUNT(*)::int AS count FROM openres_reservations')).rows[0].count).toBe(1);
  });
  it('stores hashed staff sessions and revokes them on lock',async()=>{
    const passwordHash=await hashPassword('synthetic-postgres-password');
    vi.stubEnv('OPENRES_STAFF_USERS',JSON.stringify([{id:'host',role:'staff',passwordHash}]));
    jar.token=await signIn('host','synthetic-postgres-password','test-client');
    const token=jar.token;
    expect(await currentStaff()).toEqual({actor:'host',manager:false});
    expect(JSON.stringify((await client.query('SELECT * FROM openres_sessions')).rows)).not.toContain(token);
    await signOut();jar.token=token;expect(await currentStaff()).toBeNull();
  });
  it('returns minimized repeat-visitor aggregates with PostgreSQL contact matching', async () => {
    await updateSettings({ ...DEFAULT_SETTINGS, enabled: true }, 'manager');
    const make = (email: string, phone: string) => createReservation({ id: randomUUID(), date: '2026-11-14', time: '18:00', partySize: 2, name: 'Synthetic Repeat Guest', email, phone, waitlist: true }, 'host', undefined, now);
    const emailGuest = (await make('repeat@example.com', '')).reservation;
    const phoneGuest = (await make('', '+1 (212) 555-0100')).reservation;
    for (const current of [emailGuest, phoneGuest]) {
      const past = { ...current, id: randomUUID(), date: '2026-10-01', status: 'completed', email: current.email ? ' REPEAT@EXAMPLE.COM ' : '', phone: current.phone ? '12125550100' : '' };
      await client.query('INSERT INTO openres_reservations VALUES ($1,$2,$3,$4)', [past.id, past.date, past.email, JSON.stringify(past)]);
    }
    const result = await readVisitSummaries([emailGuest, phoneGuest]);
    expect(result[emailGuest.id]).toEqual({ completedVisits: 1, lastVisit: '2026-10-01', matchedBy: 'email' });
    expect(result[phoneGuest.id]).toEqual({ completedVisits: 1, lastVisit: '2026-10-01', matchedBy: 'phone' });
    expect(JSON.stringify(result)).not.toContain('@example.com');
  });

});
