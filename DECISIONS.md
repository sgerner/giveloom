# Architecture decisions

## 2026-10-23 — Build on the supplied SvelteKit product target

The target is SvelteKit 2, Svelte 5, TypeScript, adapter-node, Drizzle/PostgreSQL, Redis/BullMQ, and Zod. Installed dependency versions are pinned in `package.json` and `package-lock.json`; check API usage against those installed versions before depending on theme or component behavior.

## 2026-10-23 — Tenant isolation is a database and service invariant

Tenant-owned rows carry `tenant_id`; tenant-aware references use composite tenant keys, and PostgreSQL RLS is enabled and forced. The server determines the active tenant from an authorized membership. A caller-supplied tenant id alone never grants access.

## 2026-10-23 — Financial values and event history

Persist money as integer minor units and ISO 4217 currency, timestamps in UTC, and gifts as immutable ledger events. Correct a recorded gift with a new attributable event rather than erasing the original.

## 2026-10-23 — Integration defaults fail closed

Production behavior is disabled until an authorized provider connection exists. Test adapters are explicitly labeled and live under `test-adapters.ts`; they must never be selected implicitly in production. Codex device-code access is disabled; an OpenAI-compatible tenant API key is the supported direction only after an actual provider adapter and credential controls exist.

## 2026-10-23 — Files stay private on local storage by default

Filesystem object IDs are opaque UUIDs stored under tenant UUID directories. Original filenames never form paths, uploads are size/type/signature checked, and download links are short lived and signed. Authenticated routes still need to resolve authorization before streaming.

## 2026-10-23 — Transactional outbox hands work to durable queues

Write an outbox record in the same database transaction as its domain mutation. The worker enumerates tenants, reads each outbox under transaction-local RLS context, and hands it to BullMQ with a stable event UUID as job id plus an HMAC-signed tenant context. `processed_at` records durable dispatch to the queue, while BullMQ job state records execution. Handlers use tenant-scoped transactions and stable idempotency keys; retry exhaustion remains visible. Unknown event types fail and are not reported as successful.

## 2026-10-23 — Deployment uses pinned containers and named volumes

Compose pins service image tags, runs application containers without root, provides health checks and resource limits, and persists PostgreSQL, Redis, uploads, exports, backups, and Caddy state in named volumes. Backups pause external writes/queue consumption and archive DB plus files; operators must copy backups off-host and run restore drills.

## 2026-10-23 — Separate PostgreSQL runtime and migration roles

The PostgreSQL bootstrap account is restricted to the database bootstrap service. The web/worker runtime role is `NOSUPERUSER NOBYPASSRLS` and does not own tenant tables. A separate non-superuser migration role owns schema objects and has DDL privileges. Runtime access to tenant-owned tables depends on transaction-local RLS context; login must read memberships in the selected tenant context.

## Deferred decisions

- Product name and domain remain unselected. `Donor CRM` is a neutral working label; no trademark or domain availability is implied.
- AWS SES implementation, Stripe Connect onboarding mode, source licensing and any commercial prospect vendor require verification before integration is enabled.
- Optional S3-compatible storage and malware scanning require a separately configured service and operational contract.

## 2026-10-23 — Verified package and theme APIs

The installed foundation is SvelteKit 2.70.3, Svelte 5.57.2, Skeleton 5.0.1 and Tailwind 4.3.1. `scripts/themes.mjs` enumerates the installed Skeleton CSS exports into the theme registry; all 24 shipped themes are available. The original Donor CRM brand palette is a separate option, not a renamed built-in theme. Theme aliases use Skeleton's light/dark tokens. The neutral logo concept remains subject to human review.

## 2026-10-23 — Standalone worker packaging

The worker cannot execute SvelteKit virtual environment modules under plain Node. `scripts/build-worker.mjs` bundles server services, maps private environment access to Node process environment, and leaves vendor packages external. Production runs `node build/worker.js`. This is verified at module-load level; live Redis dispatch remains unverified here.

## 2026-10-23 — Non-root proxy listeners

Caddy listens internally on 8080/8443 while Compose publishes standard 80/443 ports, avoiding privileged listeners. Caddy documents that these global port options affect internal listeners, not client-facing ports: https://caddyserver.com/docs/caddyfile/options. Persistent volumes created by older root-running versions require an ownership migration before upgrade.

## 2026-10-23 — Keep SvelteKit 2 and document the remaining low advisories

The project requirement is SvelteKit 2, so do not take a major-version upgrade solely to clear advisories whose fixes currently require SvelteKit 3. The installed `@sveltejs/kit` is 2.70.3. The current dependency audit reports two low SvelteKit advisories: [GHSA-pfhg-q3qv-9q6r](https://github.com/sveltejs/kit/security/advisories/GHSA-pfhg-q3qv-9q6r) covers open redirects when `use:enhance` is used on actions reached through paths beginning `//`; [GHSA-27mw-82g8-phjj](https://github.com/sveltejs/kit/security/advisories/GHSA-27mw-82g8-phjj) covers untrusted `cache-control` headers passed to `setHeaders` on prerendered pages. This repository currently has no `use:enhance` calls, and the only native form action targets the same-origin Stripe-connect API endpoint. No route enables prerendering; the few `setHeaders` calls use fixed private/no-store values. These inspected code paths do not appear to meet the advisories' stated conditions, but that is a code-scope assessment, not a patched dependency or blanket guarantee. Reassess before introducing enhanced form actions, prerendering, or user-derived cache headers. The separate high-severity Zod oversized-collection advisory was fixed by upgrading to Zod 4.6.7; current audit output contains only the two low SvelteKit findings.
