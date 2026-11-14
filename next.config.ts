import type { NextConfig } from 'next';
const config: NextConfig = {
  distDir: process.env.NEXT_BUILD_DIR || '.next',
  output: 'standalone',
  serverExternalPackages: ['better-sqlite3', 'pg'],
  poweredByHeader: false,
  async headers() { return [{ source: '/api/:path*', headers: [{ key: 'Content-Security-Policy', value: "default-src 'none'; frame-ancestors 'none'" }] }, { source: '/:path*', headers: [
    { key: 'Referrer-Policy', value: 'no-referrer' },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
    { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
  ] }]; },
};
export default config;
