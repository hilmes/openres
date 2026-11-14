# Security and privacy

OpenRes is an early self-hosted application. Do not enable real guest intake until the operator has verified access controls, HTTPS, backup/retention practices, notification delivery and inventory ownership.

## Reporting a vulnerability

Use the repository's private security advisory reporting feature when available. If it is unavailable, open an issue asking for a private reporting channel **without** including the exploit, tokens, account details or guest information. Never put live booking links, passwords, database dumps or personal data in public issues.

## Trust boundaries

- Guest management links are bearer capabilities. Anyone possessing one can read/manage that reservation. They have no independent email verification or automatic expiry yet; secret rotation invalidates all existing links.
- Creation retries require a separate random request key; public record IDs and contact details do not authorize receipt recovery. Only the retry-key hash is stored. Booking rate counters persist even when the inventory transaction rejects the request.
- Staff use individually configured accounts with scrypt password hashes and eight-hour opaque sessions. Only session-token hashes are stored. Password rotation or account removal invalidates access on the next request; Lock desk deletes the session in the database. Current roles are re-evaluated on every request.
- Demo authorization is available only in explicitly enabled development mode and on loopback API hosts. Production ignores demo mode. Never expose a development server or its demo routes to the internet.
- Booking and login limits use keyed hashes, not raw IP storage. Reverse-proxy headers are trusted only when the operator explicitly enables that configuration.
- Inventory writes and settings changes use a single-venue transaction lock in PostgreSQL. Every installation must have its own database. There is no tenant boundary for sharing one database among venues.
- Audit records share the application's database trust boundary. They are not immutable or tamper-proof. Fixture attestations identify snapshots that passed through the configured catalog, not independently verified events.

## Content Security Policy

Every page is rendered per request with a fresh nonce (`src/proxy.ts`, `src/lib/openres/csp.ts`). Scripts and stylesheets run only with that nonce; nothing is loaded from another origin; `eval` is not allowed in production; forms and `fetch` may only reach this installation. Style attributes are allowed because the floor plan positions tables with them. API responses carry a deny-all policy. If you add a third-party script, font or embed, you must extend the policy deliberately; do not add `'unsafe-inline'` or `'unsafe-eval'` to make an error go away. The acceptance suite checks the headers and that every shipped script carries the nonce; a browser walk of the production build found no violations.

## Data handling

No third-party analytics or replay SDK is included. Contact details and notes stay out of history projections, CSV and audit-state snapshots, but remain in operational reservation records. Optional email delivery shares reservation details with the configured provider. A manager can set a retention period that removes guest details from finished visits once a day, and can erase one guest on request (see README, Privacy and provenance). Both run inside the inventory transaction and write an audit entry with counts only. They do not reach database backups, email already delivered or infrastructure logs; the operator must define procedures for those. An erased visit can no longer be matched to a returning guest or recovered by replaying its creation request.

Do not add logging of request bodies, tokens, passwords, connection strings or guest records. Do not cache guest data in localStorage, a service worker or public/CDN caches. Keep `.env.local`, `.openres`, backups and staff account configuration out of source control.

## Dependencies

Runtime dependencies are checked separately with `npm audit --omit=dev`. Development tooling can have different exposure: review full `npm audit` output as well. Do not force dependency overrides just to hide an advisory; update the supported upstream package or document the remaining issue. CI and Dependabot support ongoing maintenance.

Runtime audit reports no vulnerabilities. As of 2026-11-14 the full audit reports seven moderate development-only findings, all one advisory: typescript-eslint 8.72.2 (the latest release, pulled in by eslint-config-next) depends on minimatch ^10, and the fix is in minimatch 11. ESLint's own copy was updated. The rest clears when typescript-eslint moves to minimatch 11; recheck on dependency updates.
