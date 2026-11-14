// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
const jar=vi.hoisted(()=>({token:''}));
vi.mock('server-only',()=>({}));
vi.mock('next/headers',()=>({cookies:async()=>({get:()=>jar.token?{value:jar.token}:undefined,delete:()=>{jar.token='';}})}));
import { createReservation, eraseGuest, purgeExpired, purgeIfDue, updateSettings } from './service';
import { DEFAULT_SETTINGS, TABLES } from './model';
import { currentStaff, signIn, signOut } from './auth';
import { hashPassword } from './password';
import { readReservation, readVisitSummaries } from './store';
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

  describe('retention and erasure',()=>{
    const past=async(patch:Record<string,unknown>={})=>{
      const record={id:randomUUID(),date:'2026-09-01',time:'18:00',partySize:2,area:'any',tableId:'11',duration:90,name:'Dana Example',email:'dana@example.com',phone:'+1 (212) 555-0100',notes:'Allergy: shellfish',staffNotes:'Regular',occasion:'',status:'completed',source:'online',createdAt:'2026-08-20T12:00:00.000Z',updatedAt:'2026-09-01T23:00:00.000Z',version:1,history:[],match:{kind:'none'},...patch};
      await client.query('INSERT INTO openres_reservations (id, service_date, email, payload) VALUES ($1,$2,$3,$4)',[record.id,record.date,record.email,JSON.stringify(record)]);
      return record;
    };
    it('removes details from finished visits past the period and leaves active and recent ones',async()=>{
      await updateSettings({...DEFAULT_SETTINGS,enabled:true,retentionDays:30},'manager');
      const old=await past(), active=await past({status:'confirmed',email:'active@example.com'}), recent=await past({date:'2026-11-01',email:'recent@example.com'});
      expect(await purgeExpired('System',now)).toEqual({removed:1,more:false,retentionDays:30});
      const row=(await client.query('SELECT email, payload::text AS payload FROM openres_reservations WHERE id=$1',[old.id])).rows[0];
      expect(row.email).toBe('');
      expect(row.payload).not.toMatch(/dana|555|shellfish|Regular/i);
      expect((await readReservation(active.id))?.email).toBe('active@example.com');
      expect((await readReservation(recent.id))?.email).toBe('recent@example.com');
      expect((await client.query("SELECT action, scope FROM openres_access_audit WHERE action='retention_purge'")).rows).toEqual([{action:'retention_purge',scope:'before=2026-10-14; records=1'}]);
      expect((await purgeExpired('System',now)).removed).toBe(0);
    });
    it('claims the daily pass once across concurrent desks',async()=>{
      await updateSettings({...DEFAULT_SETTINGS,enabled:true,retentionDays:30},'manager');
      await past();
      await Promise.all([purgeIfDue(now),purgeIfDue(now)]);
      expect((await client.query("SELECT COUNT(*)::int AS n FROM openres_limits WHERE key LIKE 'retention:%'")).rows[0].n).toBe(1);
      expect((await client.query("SELECT COUNT(*)::int AS n FROM openres_access_audit WHERE action='retention_purge'")).rows[0].n).toBe(1);
    });
    it('erases one guest by email or by phone digits and refuses while a booking is in progress',async()=>{
      const visits=[await past(),await past({email:' Dana@Example.com ',date:'2025-03-01'})];
      const other=await past({email:'other@example.com'});
      expect(await eraseGuest(visits[0].id,'manager',now)).toEqual({erased:2});
      expect((await readReservation(other.id))?.email).toBe('other@example.com');
      const phone=[await past({email:'',phone:'212-555-0199'}),await past({email:'',phone:'(212) 555 0199'})];
      expect(await eraseGuest(phone[1].id,'manager',now)).toEqual({erased:2});
      const upcoming=await past({email:'busy@example.com'});
      await past({email:'busy@example.com',status:'confirmed',date:'2026-11-20'});
      await expect(eraseGuest(upcoming.id,'manager',now)).rejects.toMatchObject({status:409});
      expect((await readReservation(upcoming.id))?.email).toBe('busy@example.com');
    });
  });
});
