import type { Metadata, Viewport } from 'next';
import './globals.css';
export const metadata: Metadata = {
  title: 'OpenRes', description: 'Reservations and a restaurant floor desk.',
  referrer: 'no-referrer', robots: { index: false, follow: false },
  appleWebApp: { capable: true, title: 'OpenRes', statusBarStyle: 'default' },
};
export const viewport: Viewport = { width: 'device-width', initialScale: 1, maximumScale: 5, userScalable: true };
export default function Layout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
