# OpenRes

Self-hosted reservations and a tablet-friendly floor desk for independent venues.

OpenRes keeps the guest flow compact and gives hosts a floor plan, service list, waitlist, walk-ins, table assignments, party moves and visit history. Each installation serves one configurable venue. It is an independent project; it is not affiliated with Resy and contains no Resy code or assets.

## Try it locally

Requires Node.js 24 LTS (minimum 22.14) and npm.

```sh
npm ci
npm run demo
```

- Guest booking: http://127.0.0.1:4020/book
- Staff desk: http://127.0.0.1:4020/staff

Demo mode uses synthetic reservations in an ignored SQLite file, binds to loopback, grants demo manager access and sends no email. It is disabled in production builds and on Vercel. Use a date with available service hours. After booking, save the private management link; it is the way to test editing/cancellation without email. Select the booking's date in the staff desk.

## Make it your venue

Edit [`src/config/venue.ts`](src/config/venue.ts): venue name/contact details, IANA timezone, public links, seating areas and tables. Table positions are normalized coordinates between 0 and 1. The included floor is an original generic example, not a real venue's drawing. Configuration validation catches duplicate table IDs and invalid zones/areas. Rebuild after configuration changes; review active reservations before changing table IDs or capacities.

Ordinary reservations go straight to date, party size and time. Sports-oriented venues can enable `features.fixtures` and populate [`src/config/fixtures.ts`](src/config/fixtures.ts). Then guests choose a fixture, **+ OTHER** or **SKIP**, with Other/Skip below the fixture list. `BookingWidget` also accepts `fixtures`, `initialMatch`, date/party/time prefills and `onBooked` for calendar integration.

## Visual theme

The default skin uses warm near-black paper, bone text, restrained teal accents, Archivo body/display type and Fragment Mono labels. Fonts are served locally with their OFL notices; browsers make no font-provider requests. Theme tokens live in `src/app/globals.css`, while booking and desk layouts live in `src/components/openres/openres.module.css`.

## Deploy your own installation

Use a separate PostgreSQL database for each venue. The application is portable across Node hosts and uses the standard `pg` client; no hosting vendor account is required.

1. Copy `.env.example` to `.env.local` and configure `DATABASE_URL`, `OPENRES_BASE_URL` and a unique `OPENRES_TOKEN_SECRET` of at least 32 random characters. In production use an HTTPS base URL. Keep the token secret stable: changing it invalidates private booking links.
2. Run `npm run staff:create` to generate a salted password hash. Put the resulting object(s) in the private `OPENRES_STAFF_USERS` JSON array. Each user has a `staff` or `manager` role. Password input is hidden and plaintext passwords are not saved. Do not commit your account configuration.
3. Optionally configure `RESEND_API_KEY` and `OPENRES_EMAIL_FROM` using your own verified sender. No email provider is enabled by default. Guest receipts also provide the private management link directly.
4. Run the schema migration and build:

   ```sh
   npm run db:migrate
   npm run check
   npm run build
   npm start
   ```

5. Sign in at `/staff`, review Settings, then enable online reservations. Intake starts **off** outside demo mode. Allocate tables exclusively if another booking system is in use; OpenRes does not synchronize external inventory.

For self-hosting, terminate HTTPS at a trusted reverse proxy. Keep the Node port private. Set `OPENRES_TRUST_PROXY=1` only when the proxy overwrites `X-Forwarded-For`; otherwise callers cannot supply their own rate-limit identity and requests share a conservative fallback bucket. No production data or credentials are needed for the demo.

## Privacy and provenance

- No analytics, session replay, tracking fonts, enrichment or marketing integrations are included.
- Phone is optional. Guest history is a manager-only server projection of name, visit date/time, party size and status. Contact details and notes are excluded from that response; there is no separate guest-profile database.
- The service desk marks returning guests with prior completed-visit counts and the most recent visit at this venue. Counts use all retained completed bookings before that reservation, not just the guest book’s 5,000-row display. Matching uses normalized email first, or digits-only phone when email is absent on both bookings; it never merges by name. Shared contacts can represent different people, and changed/missing contacts can undercount visits. No extra contact data or guest profile is saved.
- Staff work with the service book. Only managers can export or browse cross-visit history, and those accesses are audited. Exports exclude email, phone and notes.
- Private guest links put their capability token in the URL fragment, not a query string. API responses are `no-store`. The shared desk clears when hidden; Lock desk revokes the server-side session.
- Booking changes carry actor, version, field names and seating state. Floor revisions are hashed. Signed fixture snapshots distinguish the operator's catalog from client-supplied details; this is source evidence, not a screening guarantee or a verified guest identity.

Operational records still retain submitted contacts and notes. Automatic retention/deletion jobs are not included in this first release. Set a retention and deletion-request policy, account for backups/email-provider retention, and validate it before real guest intake. Application audit records are not an independently immutable ledger. See [SECURITY.md](SECURITY.md) and [docs/architecture.md](docs/architecture.md).

## Development checks

```sh
npm run check
npm run build
npm audit --omit=dev
```

The suite covers booking races, idempotency, edit conflicts, waitlists, seating moves, private-link access, roles, session expiry/revocation, optional fixture selection and IANA timezone/DST behavior. For real PostgreSQL integration, create a disposable **loopback** database named `openres_test`, then run:

```sh
OPENRES_TEST_DATABASE_URL=postgres://postgres:openres-test-only@127.0.0.1:5432/openres_test npm test
```

Those tests truncate OpenRes tables and refuse any other host/database name. CI provisions its own PostgreSQL service. Test credentials are synthetic.

## Security and performance acceptance

Run the production HTTP suite against a disposable PostgreSQL database after `npm ci`:

```sh
OPENRES_TEST_DATABASE_URL=postgres://postgres:openres-test-only@127.0.0.1:5432/openres_test npm run test:audit
```

It refuses a non-loopback database or any database name other than `openres_test`, truncates its test tables, and starts a temporary production server on loopback port 4030. It covers staff roles, cookies, private-link/retry authorization, CSRF, validation, rate limits, exports, session revocation and concurrent table allocation. The load tests measure warm p50/p95 latency at eight concurrent requests (four for cross-visit history), including a synthetic book of 400 waiting parties and 5,000 total visits. They also measure initial JavaScript/CSS gzip size and font payloads. Local regression budgets are 1 second p95 for ordinary reads, 1.5 seconds for 5,000-visit history, 300 KiB JavaScript gzip and 250 KiB fonts. These are project test budgets, not production SLAs or browser Web Vitals.

Results go to the ignored `.openres/audit/results.json`; CI uploads that file. The runner stops its own app process but leaves the disposable database for the caller to remove. Never use guest records in this suite. Run independently from unit tests because both reset the same test tables.

Custom guest booking integrations must send an independently generated UUID `requestKey` alongside `id`, retain both for retries in memory, and never derive the key from guest details or the record ID. Only its hash is stored. Existing records without a retry hash remain manageable using their original private link and cannot recover a receipt by replaying creation.

## Current scope

This is an initial implementation, not full feature parity with a commercial reservation platform. Bookings support 1–8 guests and one table per party, with service windows that finish within the same venue date. Payments, deposits, SMS, automatic waitlist offers, combined tables, multi-venue tenancy and passkeys/SSO are not included. No offline guest-data cache is used; booking and table changes require a connection. Physical iPad/browser acceptance testing is required before venue rollout.

MIT licensed. Contributions are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md).
