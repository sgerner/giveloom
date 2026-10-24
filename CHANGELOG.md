# Changelog

## Unreleased

- Added an isolated public production demo with one-click homepage entry alongside real account creation. Demo sessions require explicit enablement without a production database, use a separate signing key and temporary data, and block real accounts, provider credentials and live sends. GiveLoom hostnames now use Cloudflare HTTPS redirects.

- Fixed stale donor selections and tenant refreshes, concurrent workflow frequency-cap checks and a scheduler lock conflict, webhook IP classification, and impossible saved-report dates. Added browser and real PostgreSQL regression coverage; see [the worktree review](docs/REVIEW.md).

- Fixed the core route for empty-workspace email and automations editor access, added hydration guards and paged draft loading, and improved microsecond cursor precision. Final local verification passed 137 PostgreSQL tests across 40 files, all 10 database-backed scenarios, all 9 demo journeys, all 6 production-build PWA checks, the web/worker build, worker smoke and paired database/files restore drill. Email draft editing was verified without sending.
- Added versioned campaign publication with configurable public donation forms, tenant-safe hero-image exposure, campaign variants and public attribution links; added event publication, ticket/volunteer registration, and campaign/event public pages.
- Added tenant-authorized Stripe Connect state, connected-account payment intents/subscriptions, signed webhook handling, and donor billing portal handoff. Real provider credentials and live transactions remain unverified.
- Expanded email composition, reusable sanitized templates, plain-text fallback, consent/suppression snapshots, recipient-bound approval, one-use scheduled batches, transactional test-send controls, opt-in/preferences, idempotent per-recipient outbox delivery, signed SNS event processing, and read-only SES sender/DNS/sandbox/quota diagnostics.
- Expanded the workflow editor and trigger/action contracts, including segment and engagement triggers, current-context simulation, durable run/step dispatch, role-checked actions, exact-endpoint webhook actions, one-use email approval, and budgeted AI-assisted unsent drafts.
- Added ledger-backed report insights, saved report definitions and schedules with fresh-membership checks, tenant-local delivery scheduling, and audited report snapshots.
- Exposed average lifetime net giving and UTC calendar-year donor retention; scoped recurring/churn metrics to supported campaign, fund and donor filters, and suppress incompatible pipeline panels with a clear explanation.
- Added donor portal magic links and sessions, gift/acknowledgment views, privacy and preference controls, public tenant name/logo/theme presentation, and Stripe billing-portal handoff.
- Added staff email verification, password recovery, membership/invitation and session management, TOTP MFA, tenant-scoped API tokens, signed webhook subscriptions/retries, platform tenant health controls, and retention policy operations.
- Added tenant branding/legal settings and onboarding progress backed by actual workspace records; optional tax ID remains owner/admin-only. Public logos use a dedicated metadata table, image magic checks, malware scanning, an explicit public-display consent flag, and a fail-closed production image route.
- Added collection directory indexes and migration `0033_collection_directory.sql`; migrations through `0033` apply cleanly on an empty database and on repeat invocation.
- Added household directory hard-credit totals by currency, including correction adjustments and merged-member alias handling; soft credits are excluded.
- Added the prospect research funnel/queue, visible recurring-gift churn cohorts with explicit status-history coverage, and collection directories for organizations, households and segments.
- Added per-gift acknowledgment snapshots, authorized financial metadata listing and HTML downloads. This records an acknowledgment; it does not claim that an email receipt was sent.
- Added tenant-authorized private file upload, listing and authenticated download with bounded multipart input, same-tenant contact references, audit events, and production fail-closed ClamAV scanning.
- Added separated PostgreSQL bootstrap, migration and non-superuser runtime roles, durable BullMQ outbox dispatch, provider interfaces, encrypted tenant credential storage, and operator backup/restore scripts. The paired PostgreSQL database/files restore drill passed; production deployment and off-host backup drills remain open.

See [FEATURE_STATUS.md](FEATURE_STATUS.md) for implementation coverage and [docs/VALIDATION.md](docs/VALIDATION.md) for current test evidence and remaining external gates. Database tests do not establish full specification completion or production readiness.
