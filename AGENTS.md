# OpenRes contributor instructions

- Use Beads (`bd`) for work tracking. Keep personal data, credentials and local databases out of Git and issue descriptions.
- Read README.md, SECURITY.md and docs/architecture.md before changing service or auth behavior.
- Venue-specific settings belong in `src/config/venue.ts`; never hardcode a real venue, guest, sender or integration credential in the engine.
- Keep guest responses separate from staff records. Enforce roles on the server, preserve audit provenance, and never add session replay or guest-data telemetry.
- Use synthetic data in tests. PostgreSQL integration tests may run only against a loopback database named `openres_test`.
- Run `npm run check` and `npm run build` for feature changes. Use targeted checks for small fixes. Read each result before claiming success.
- Keep commits scoped and review the staged diff. File remaining work, sync Beads, and push the branch before handing off.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
