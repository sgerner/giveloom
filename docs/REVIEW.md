# Worktree review — 24 October 2026

The review covered the current application source, with parallel reviews of financial reporting, security, and workflow execution. This checkout has no `.git` metadata, so a comparison against a base revision was unavailable. Changes remain local and uncommitted.

## Concrete issues addressed

| Priority | Finding and correction                                                                                                                                                                                                                                                                             | Regression coverage                                                                                                                                     |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1       | Typing a new supporter search retained the previously selected donor ID. Clear the selection immediately and block submission while an unresolved search remains. Cancel pending searches when selecting or clearing a donor so late results cannot reopen the picker.                             | Browser coverage verifies selection invalidation, blocked gift submission, explicit anonymous entry, and a delayed pagination response after selection. |
| P2       | A delayed refresh from the previous tenant could replace the currently selected workspace. Guard responses with a request generation and tenant identity, and serialize tenant switches.                                                                                                           | Browser coverage holds a Riverstone response until Harbor has loaded, then verifies that releasing it cannot replace Harbor's data.                     |
| P2       | Concurrent distinct workflow events could both pass the same frequency cap. Serialize the cap check and run creation with a transaction-scoped advisory lock. Use deterministic workflow ordering and a scheduler row lock compatible with foreign-key checks to avoid a scheduler/event deadlock. | Real PostgreSQL tests cover simultaneous events and the scheduler/event lock cycle.                                                                     |
| P2       | Webhook destination checks accepted additional special-purpose IP ranges and inconsistent IPv6 spellings. Canonicalize IPv6 and reject non-global allocations while preserving explicitly reachable exceptions.                                                                                    | Unit coverage includes IPv4 relay space, mapped addresses, IPv6 documentation/benchmark allocations, reachable exceptions, and their prefix boundaries. |
| P2       | Saved report filters accepted impossible calendar dates that JavaScript normalized to another date. Require an exact ISO calendar-date round trip.                                                                                                                                                 | Leap-year and invalid-date tests, plus a real PostgreSQL definition-creation rejection.                                                                 |

## Verification

Passed 140 tests across 40 files against real PostgreSQL; 10 database browser scenarios, 12 demo browser scenarios and 6 production PWA scenarios; Svelte/TypeScript (zero errors or warnings), ESLint, repository formatting, the production web/worker build, and standalone worker dispatch with real Redis.

## Residual risks and limits

- Workflow frequency caps currently measure run creation time. Runs held by long waits or quiet windows can therefore execute closer together than the cap interval. Changing the cap to execution time requires a product decision and additional scheduling tests.
- Existing saved definitions containing invalid dates are not automatically repaired. New and updated definitions reject those dates; operators should review legacy definitions if upgrading an existing installation.
- The IP allocation policy is maintained in code. Future changes to the [IANA IPv4 registry](https://www.iana.org/assignments/iana-ipv4-special-registry) or [IPv6 registry](https://www.iana.org/assignments/iana-ipv6-special-registry) require review.
- Live Stripe, SES and AI integration verification remains deferred until credentials are configured. Docker/Compose deployment, production ClamAV, off-host backup operation, physical-device installation and manual screen-reader checks remain open. Local tests use test transports and do not establish production readiness.

See [VALIDATION.md](VALIDATION.md) for test results and external acceptance gates.
