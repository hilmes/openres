# Contributing

Use Node.js 24 LTS and `npm ci`. Start the synthetic demo with `npm run demo`.

Keep venue behavior configurable. Preserve the compact guest flow and touch-sized staff controls. Feature changes should include tests for real behavior: inventory races, authorization, state transitions and privacy boundaries are more valuable than tests mirroring component markup.

Run `npm run check` and `npm run build` before submitting a pull request. PostgreSQL integration tests use only a disposable loopback database named `openres_test`; CI runs them automatically. Do not include generated build output, environment files, guest records or your local demo database.

Use Beads for project work tracking and GitHub issues for public discussion. Keep issue descriptions generic and free of personal data. Report security problems privately as described in SECURITY.md.

Contributions are provided under the repository's MIT license. By submitting code, you represent that you can contribute it under those terms. Do not copy commercial reservation products' source, assets or branding.
