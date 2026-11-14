import { StaffLogin } from '@/components/openres/StaffLogin';
export const metadata = { title: 'Staff sign-in · OpenRes' };
// Rendered per request so the page's scripts carry that request's CSP nonce.
export const dynamic = 'force-dynamic';
export default function Page() { return <StaffLogin />; }
