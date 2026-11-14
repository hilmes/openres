import { ManagePage } from '@/components/openres/ManagePage';
export const metadata = { title: 'Your reservation · OpenRes' };
// Rendered per request so the page's scripts carry that request's CSP nonce.
export const dynamic = 'force-dynamic';
export default function Page() { return <ManagePage />; }
