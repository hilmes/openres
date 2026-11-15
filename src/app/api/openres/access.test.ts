// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ currentStaff:vi.fn(), readReservations:vi.fn(), readSettings:vi.fn(), recordAccessAudit:vi.fn(), readReservation:vi.fn(), visitHistory:vi.fn(), purgeExpired:vi.fn(), eraseGuest:vi.fn(), refundDepositNow:vi.fn(), supporterContacts:vi.fn(), supporterTeams:vi.fn() }));
vi.mock('server-only',()=>({}));
vi.mock('@/lib/openres/auth',()=>({currentStaff:mocks.currentStaff}));
vi.mock('@/lib/openres/store',()=>({localMode:()=>false,...mocks}));
vi.mock('@/lib/openres/service',()=>({visitHistory:mocks.visitHistory,verifyManagementToken:(_id:string,token:string)=>token==='valid',createReservation:vi.fn(),updateReservation:vi.fn(),purgeIfDue:vi.fn(),settleLapsedDeposits:vi.fn(),settleDeposit:vi.fn(),confirmPayment:vi.fn(),refundDepositNow:mocks.refundDepositNow,advanceWaitlist:vi.fn(async()=>[]),advanceWaitlistIfDue:vi.fn(async()=>[]),purgeExpired:mocks.purgeExpired,eraseGuest:mocks.eraseGuest,supporterContacts:mocks.supporterContacts,supporterTeams:mocks.supporterTeams}));
vi.mock('@/lib/openres/email',()=>({sendReservationEmail:vi.fn(),sendOfferEmail:vi.fn()}));
import { GET as desk, PATCH as deskPatch } from './desk/route';
import { GET as exportBook } from './export/route';
import { GET as guest } from './reservations/[id]/route';
import { POST as retention } from './retention/route';
import { GET as supporters } from './supporters/route';
import { body } from '@/lib/openres/http';
beforeEach(()=>{vi.clearAllMocks();vi.unstubAllEnvs();});
it('rejects unauthenticated staff access before loading guest data',async()=>{
  mocks.currentStaff.mockResolvedValue(null);
  expect((await desk(new Request('https://example.com/api/openres/desk'))).status).toBe(401);
  expect(mocks.readReservations).not.toHaveBeenCalled();
});
it('restricts exports and cross-visit history to managers',async()=>{
  mocks.currentStaff.mockResolvedValue({actor:'host',manager:false});
  expect((await desk(new Request('https://example.com/api/openres/desk?view=guests'))).status).toBe(403);
  expect((await exportBook(new Request('https://example.com/api/openres/export'))).status).toBe(403);
  expect(mocks.readReservations).not.toHaveBeenCalled();
});
it('returns only projected history and audits the read',async()=>{
  mocks.currentStaff.mockResolvedValue({actor:'manager',manager:true});
  mocks.readReservations.mockResolvedValue([{id:'record',email:'private@example.com',notes:'Private note'}]);
  mocks.visitHistory.mockReturnValue([{id:'record',name:'Test Guest',guestKey:'opaque',date:'2026-11-13',time:'18:00',partySize:2,status:'completed'}]);
  const response=await desk(new Request('https://example.com/api/openres/desk?view=guests'));
  const data=await response.json();
  expect(data.reservations).toEqual([]);
  expect(JSON.stringify(data)).not.toContain('private@example.com');
  expect(mocks.recordAccessAudit).toHaveBeenCalledWith('manager','guest_history_view','records=1');
});
it('does not reveal a booking without its private link token',async()=>{
  expect((await guest(new Request('https://example.com/api/openres/reservations/test'),{params:Promise.resolve({id:'550e8400-e29b-41d4-a716-446655440000'})})).status).toBe(401);
  expect(mocks.readReservation).not.toHaveBeenCalled();
});
it('rejects cross-origin requests and oversized bodies',async()=>{
  await expect(body(new Request('https://example.com/api/openres/desk',{method:'POST',headers:{origin:'https://other.example','Content-Type':'application/json'},body:'{}'}))).rejects.toMatchObject({status:403});
  await expect(body(new Request('https://example.com/api/openres/desk',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({notes:'x'.repeat(20000)})}))).rejects.toMatchObject({status:413});
});
it('accepts the browser host when Next uses an internal listener URL',async()=>{
  const request=new Request('http://localhost:4020/api/openres/reservations',{method:'POST',headers:{Host:'127.0.0.1:4020',Origin:'http://127.0.0.1:4020','Content-Type':'application/json'},body:'{"partySize":2}'});
  await expect(body(request)).resolves.toEqual({partySize:2});
});
it('uses the configured HTTPS origin behind a proxy and rejects a forged host',async()=>{
  vi.stubEnv('OPENRES_BASE_URL','https://book.example.com');
  const request=(origin:string)=>new Request('http://localhost:4020/api/openres/desk',{method:'POST',headers:{Host:'unrelated.example',Origin:origin,'Content-Type':'application/json'},body:'{}'});
  await expect(body(request('https://book.example.com'))).resolves.toEqual({});
  await expect(body(request('http://unrelated.example'))).rejects.toMatchObject({status:403});
});
it('lets only managers run the retention pass or erase a guest',async()=>{
  const call=(payload:unknown)=>retention(new Request('https://example.com/api/openres/retention',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}));
  mocks.currentStaff.mockResolvedValue(null);
  expect((await call({action:'purge'})).status).toBe(401);
  mocks.currentStaff.mockResolvedValue({actor:'host',manager:false});
  expect((await call({action:'purge'})).status).toBe(403);
  expect((await call({action:'erase',id:'550e8400-e29b-41d4-a716-446655440000'})).status).toBe(403);
  expect(mocks.purgeExpired).not.toHaveBeenCalled();
  expect(mocks.eraseGuest).not.toHaveBeenCalled();
  mocks.currentStaff.mockResolvedValue({actor:'manager',manager:true});
  mocks.purgeExpired.mockResolvedValue({removed:2,more:false,retentionDays:90});
  mocks.eraseGuest.mockResolvedValue({erased:3});
  expect(await (await call({action:'purge'})).json()).toEqual({removed:2,more:false,retentionDays:90});
  expect(await (await call({action:'erase',id:'550e8400-e29b-41d4-a716-446655440000'})).json()).toEqual({erased:3});
  expect(mocks.eraseGuest).toHaveBeenCalledWith('550e8400-e29b-41d4-a716-446655440000','manager');
  expect((await call({action:'erase',id:'not-a-uuid'})).status).toBe(400);
  expect((await call({action:'everything'})).status).toBe(400);
});
it('lets only a manager refund a deposit outside the policy',async()=>{
  const call=()=>deskPatch(new Request('https://example.com/api/openres/desk',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:'550e8400-e29b-41d4-a716-446655440000',action:'refund_deposit'})}));
  mocks.currentStaff.mockResolvedValue(null);
  expect((await call()).status).toBe(401);
  mocks.currentStaff.mockResolvedValue({actor:'host',manager:false});
  expect((await call()).status).toBe(403);
  expect(mocks.refundDepositNow).not.toHaveBeenCalled();
  mocks.currentStaff.mockResolvedValue({actor:'manager',manager:true});
  mocks.refundDepositNow.mockResolvedValue({id:'550e8400-e29b-41d4-a716-446655440000',payment:{status:'refunded'}});
  expect((await call()).status).toBe(200);
  expect(mocks.refundDepositNow).toHaveBeenCalledWith('550e8400-e29b-41d4-a716-446655440000','manager');
});
it('keeps the supporter list to managers, lists only one team, and audits each list without naming anyone',async()=>{
  const call=(query='')=>supporters(new Request(`https://example.com/api/openres/supporters${query}`));
  mocks.currentStaff.mockResolvedValue(null);
  expect((await call()).status).toBe(401);
  mocks.currentStaff.mockResolvedValue({actor:'host',manager:false});
  expect((await call('?team=Arsenal&format=csv')).status).toBe(403);
  expect(mocks.readReservations).not.toHaveBeenCalled();
  mocks.currentStaff.mockResolvedValue({actor:'manager',manager:true});
  mocks.readReservations.mockResolvedValue([]);
  mocks.supporterTeams.mockReturnValue([{team:'Arsenal',guests:3,contactable:1}]);
  mocks.supporterContacts.mockReturnValue([
    {name:'=Formula Guest',email:'asked@example.com',team:'Arsenal',askedAt:'2026-11-12T17:00:00.000Z',lastBooked:'2026-11-13',visits:2},
    {name:'Other Guest',email:'other@example.com',team:'Chelsea',askedAt:'2026-11-12T17:00:00.000Z',lastBooked:'2026-11-13',visits:0},
  ]);
  expect(await (await call()).json()).toEqual({teams:[{team:'Arsenal',guests:3,contactable:1}]});
  expect(mocks.recordAccessAudit).not.toHaveBeenCalled();
  const file=await call('?team=Arsenal&format=csv');
  expect(file.headers.get('Content-Type')).toContain('text/csv');
  expect(file.headers.get('Content-Disposition')).toBe('attachment; filename="supporters-arsenal.csv"');
  expect(file.headers.get('Cache-Control')).toBe('private, no-store');
  const text=await file.text();
  expect(text.split('\r\n')).toEqual([
    '"Name","Email","Team","Asked for updates","Last booked","Completed visits"',
    '"\'=Formula Guest","asked@example.com","Arsenal","2026-11-12","2026-11-13","2"',
  ]);
  expect(text).not.toContain('other@example.com');
  expect(mocks.recordAccessAudit).toHaveBeenCalledWith('manager','supporter_list_export','records=1');
});
