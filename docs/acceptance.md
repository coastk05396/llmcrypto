# Acceptance evidence and delivery boundary

Candidate: `main-20261019-feat-llm-gateway`, based on `a036823`; the signed implementation commit and PR identify the final artifact. This record supersedes historical slice notes in `tasks/todo.md` when they describe an earlier toolchain or missing frontend. Local implementation is distinct from complete production acceptance.

## Requirement coverage

| Gate | Implemented and tested locally | Remaining external acceptance |
| --- | --- | --- |
| A1 public website | Responsive themes, sample catalog/search/copy, setup/docs/navigation; `public.spec.ts`, contract endpoint drift checks | Approved live catalog/prices, user visual sign-off and actual supported setup integrations |
| A2 wallet identity | EVM/TRON verification, replay/binding/linking/isolation and injected-wallet browser journeys; identity/wallet/session suites | Real browser wallet extensions and approved recovery/contract-wallet policy |
| A3 deposits | Intent/confirmation/review/replay/replacement/reorg ledger behavior; chain/deposit/operator suites and billing browser journey | Approved custody, networks/assets/finality, real chain adapter and authorized sandbox transfer |
| A4 key and request journey | Scoped one-time keys, revocation, stream/non-stream fake-provider requests, usage/ledger reconciliation | Real provider credentials, SDK compatibility, provider-reported usage and cancellation evidence |
| A5 concurrency and uncertainty | Reservation/settlement/idempotency tests plus genuine PostgreSQL multi-connection races | Application PostgreSQL driver/shared hosting, actual provider uncertainty and approved billing policy |
| A6 reporting | Immutable price snapshots, usage/detail/filtered exports and balances; reporting/usage/settlement/browser tests | Approved commercial pricing source and live-provider reconciliation |
| A7 alternate sign-in | Password/recovery, fake Telegram, restricted API-key sign-in, session boundary/revocation tests and browser flows | Real Telegram integration, production abuse controls and recovery decisions |
| A8 diagnostics and project tools | Local import diagnostics, opt-in optimization controls, agent runs, project memory and fake-channel isolation/delivery tests | Real channel adapters; no measured model savings or provider batching support |
| A9 repository and design | Bounded archive analysis, evidence graph/export/deletion; metered fake design revision/export; enabled and disabled beta browser checks | Approved beta contracts and real-model design output quality; default-off flags do not establish production acceptance |
| A10 operators and recovery | Two-operator adjustment/elevation/audit flows, event-backed compensation; historical isolated PGlite restore drill | Mandatory stronger operator authentication, staging recovery/rollback, alert delivery/schedules and production operations |

The 13-migration restore drill predates subsequent security migrations; see [backup evidence](operations/backup.md). Genuine PostgreSQL tests use a test-only `pg` adapter; the application runtime remains PGlite. The worker entrypoint does not schedule all available job functions. These are explicit unfinished production requirements.

## Verification

The final frozen-source unit/contract/integration run passed **977 tests across 46 files**, with `REQUIRE_REAL_POSTGRES=true` and no skipped tests. Lint, workspace/tests typecheck, build and locked installation passed. Final command results are recorded in the delivery checkpoint in [tasks/todo.md](../tasks/todo.md). The full browser run before the last focused backend fixes passed 140 tests with one conditional skip. The final focused beta/billing/operator run passed 21 with the disabled-beta case skipped; a separate flags-off run passed that case. Both use the real local API with deterministic fake external adapters. The later credential-evidence parser fix received 87 focused graph/repository tests and the complete 977-test rerun; the full browser baseline predates that parser fix.

On this WSL host, a closed-port readiness probe stalled before Playwright spawned its servers. Browser verification therefore prestarted the exact commands/environment from `tests/e2e/playwright.config.ts` and used an external temporary config allowing reuse. Repository CI retains normal server startup and one browser worker; no production server or credentials were used.

See [independent review](review.md), [performance limits](performance.md), [dependency audit](dependency-audit.md), [security limitations](security-notes.md) and the [release checklist](release-checklist.md). Production deployment and real funds are not authorized by this PR.
