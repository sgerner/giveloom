# Contributing to GiveLoom

Thanks for helping improve GiveLoom. Contributions can include bug fixes, focused product improvements, accessibility work, documentation, and tests.

## Before you start

- Search existing issues and pull requests for related work. For substantial changes, open an issue first to discuss the problem and approach.
- Keep changes focused and describe user-visible behavior, data implications, and any rollout or migration steps.
- Do not include real donor data, credentials, access tokens, or provider responses in code, tests, screenshots, logs, or issue reports. Use synthetic fixtures.
- For security vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

## Development setup

Use Node.js 22 (the CI version) and npm. The demo can run without external services:

```sh
npm ci
npm run dev
```

With no `DATABASE_URL`, GiveLoom starts in labeled demo mode. Database-backed work also needs PostgreSQL and, for background jobs, Redis. Configure local environment variables using [`.env.example`](.env.example) and [the operations guide](docs/operations.md). Keep `.env` and any local donor data out of commits.

## Before opening a pull request

Run the checks that cover your change. The continuous integration workflow runs:

```sh
npm ci
npm run format:check
npm run lint
npm audit --audit-level=high
npm run check
npm test
npm run test:db
npm run build
npx playwright install --with-deps chromium
npm run test:e2e
npx playwright test --config playwright.pwa.config.ts
```

Database-backed browser journeys are also run in CI through the browser-only mode of `npm run test:db`. Some checks need local PostgreSQL, Redis, or Playwright Chromium; explain any unavailable check and its reason in the pull request. Do not point tests at live payment, email, or AI provider accounts.

If you change database behavior, include migration and tenant-isolation coverage as appropriate. Changes that handle supporter or gift data should preserve tenant scoping, consent and suppression rules, auditability, and safe exports. If you change an API, update the OpenAPI source and generated specification where applicable. If you change product behavior or operational requirements, update the relevant docs and [FEATURE_STATUS.md](FEATURE_STATUS.md).

## Pull request guidance

Please include:

- The problem being addressed and the behavior changed.
- Relevant test commands and results.
- Screenshots for visual changes, including mobile where relevant; use synthetic data only.
- Notes on schema changes, environment variables, external provider setup, or operational impact.
- Known limitations or follow-up work.

Keep pull requests reviewable and avoid unrelated formatting or generated-file churn. CI must pass before a change is ready to merge. Maintainers may ask for adjustments to protect donor privacy, tenant boundaries, security, and accessibility.

## Project state

GiveLoom is actively developing. The feature ledger distinguishes implemented code from end-to-end acceptance; please avoid presenting provider paths or deployment scenarios as production-verified unless the outstanding checks have actually been completed. See [FEATURE_STATUS.md](FEATURE_STATUS.md) and [docs/VALIDATION.md](docs/VALIDATION.md).

## License

By submitting a contribution, you agree that it is provided under the project's [MIT License](LICENSE).
