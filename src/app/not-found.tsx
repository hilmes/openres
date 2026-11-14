import { connection } from 'next/server';
import { DEFAULT_PATHS } from '@/lib/openres/paths';
export const metadata = { title: 'Not found · OpenRes' };
/** Rendered per request, like every other page, so its scripts carry that request's CSP nonce. */
export default async function NotFound() {
  await connection();
  return <main style={{ maxWidth: 520, margin: '18vh auto', padding: '0 24px' }}>
    <h1 style={{ fontSize: 28, fontWeight: 600, margin: '0 0 12px' }}>Page not found</h1>
    <p style={{ color: 'var(--muted)', margin: '0 0 24px' }}>That address does not exist here.</p>
    <a href={DEFAULT_PATHS.book} style={{ textDecoration: 'underline', textUnderlineOffset: 3 }}>Book a table</a>
  </main>;
}
