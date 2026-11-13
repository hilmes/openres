// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ currentStaff:vi.fn(), readReservations:vi.fn(), readSettings:vi.fn(), recordAccessAudit:vi.fn(), readReservation:vi.fn(), visitHistory:vi.fn() }));
vi.mock('server-only',()=>({}));
vi.mock('@/lib/openres/auth',()=>({currentStaff:mocks.currentStaff}));
vi.mock('@/lib/openres/store',()=>({localMode:()=>false,...mocks}));
vi.mock('@/lib/openres/service',()=>({visitHistory:mocks.visitHistory,verifyManagementToken:(_id:string,token:string)=>token==='valid',createReservation:vi.fn(),updateReservation:vi.fn()}));
vi.mock('@/lib/openres/email',()=>({sendReservationEmail:vi.fn()}));
import { GET as desk } from './desk/route';
import { GET as exportBook } from './export/route';
import { GET as guest } from './reservations/[id]/route';
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
