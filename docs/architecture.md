# Architecture

OpenRes is a Next.js/React application for one venue per installation. All UI branding, timezone, seating areas and floor coordinates come from `src/config/venue.ts`. The public config is bundled into browsers and must never contain secrets. The optional fixture catalog is a separate public configuration file.

## Layers

- `src/components/openres`: embeddable guest booking, guest management and staff operations. The default staff view pairs the floor with the service list. Other/Skip follow the fixture list when that feature is enabled.
- `src/lib/openres/model.ts`: input validation, availability, table fit, transition rules and guest response projection.
- `src/lib/openres/service.ts`: private-key-authorized idempotent creation, optimistic version checks, atomic table allocation and source/change provenance.
- `src/lib/openres/store.ts`: SQLite demo storage and standard PostgreSQL persistence. Production mutations use `BEGIN`, a transaction-scoped advisory lock and `COMMIT`/`ROLLBACK` on the same connection.
- `src/lib/openres/auth.ts`: individual staff/manager accounts, hashed session tokens, expiry, revocation and distributed login limits. `password.ts` uses Node's asynchronous scrypt with random salts and constant-time comparison.
- `src/lib/openres/time.ts`: IANA timezone conversion that rejects missing/repeated wall-clock times and supports non-hour offsets.
- `src/app/api/openres`: authenticated/no-store HTTP boundary. Guest creation and management are separate from staff/manager operations. Mutations require JSON and reject cross-origin submissions. Request bodies are size-limited while streaming.

## Storage

`openres_reservations` stores the operational record plus application provenance; `openres_settings` stores current service/inventory policy; `openres_limits` stores expiring booking/login counters; `openres_sessions` stores hashed staff sessions; `openres_access_audit` records manager reads/exports, settings changes and sign-ins.

The service desk derives contact-based visit summaries directly from retained completed reservations using indexed aggregate queries. It returns only count, last visit date and match method; historical contacts and notes are not returned. Email takes precedence over phone, and a missing contact never falls back to name matching. The manager-only guest book remains a separate minimized view.

Availability reads do not acquire the inventory write lock; they are advisory, and every mutation rechecks allocation atomically. A bounded cache stores timezone conversion results only, never guest data or booking availability.

A seated overstay continues blocking its table until staff complete the visit. Walk-ins use the actual current minute. Moving a seated party checks the remaining visit against other bookings. Waitlist entries hold no inventory, except a live offer: `advanceWaitlist` in `service.ts` holds a freed table for one waitlisted party until the offer expires, and `availableTables` counts that hold against guest bookings but not staff actions. There is no integration that silently imports external reservations or camera observations.

## Retention and erasure

`purgeExpired` and `eraseGuest` in `service.ts` anonymize records in place under the same transaction lock as bookings: the row keeps its ID, date, time, party, table, status and source, and loses everything that identifies the guest. `purgeIfDue` is called on staff desk reads and claims one run per venue day through `openres_limits`, so no scheduler is required and concurrent instances do not repeat the pass. Anonymized rows are excluded from repeat-visit matching because they no longer have a contact.

## Adapters and extension points

Email delivery is optional and isolated in `email.ts`; the bundled adapter uses a venue-configured Resend sender. Fixtures default to an operator-managed catalog with no outbound feed request. Replace that adapter explicitly if a venue needs a licensed provider feed, preserving source IDs and capture timestamps. A fixture attestation is not a screening promise.

Staff authentication is portable and does not depend on the original venue's account system. SSO or passkeys can replace the adapter if role checks, revocation and server-enforced permissions remain intact. Production infrastructure and identity-provider setup are deployment responsibilities.

## Provenance and distribution

The initial reservation implementation was extracted from a privately developed venue-specific prototype into fresh Git history. Only the reservation source and synthetic tests were retained. Venue drawings, guest data, secrets, tracking integrations, proprietary fonts and private Git history were excluded. The sample floor geometry was authored for OpenRes. No Resy source code, logos or assets are included.

The application is MIT licensed. Dependency licenses remain their own and are recorded in package metadata/lockfiles. Icons come from Lucide; Archivo and Fragment Mono are self-hosted under their included SIL Open Font License notices. Operators supplying assets or fixture data are responsible for their provenance and distribution rights.

## Known first-release work

Individually expiring guest links, passkeys/SSO, multi-venue isolation, table combinations, overnight service, payments and notification channels beyond email are not implemented. A retention period and physical tablet acceptance testing must precede a live venue rollout. These limits are surfaced in the README rather than represented as completed features.
