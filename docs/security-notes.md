# Security notes: fixed, decided, and known gaps

Status after the security review round (2026-10-19). Test names refer to `tests/integration/*` unless noted.

## Fixed (with tests)

| Finding | Change | Test |
| --- | --- | --- |
| URL credential evidence boundary | Long source evidence lines are omitted before snippet truncation; both URL specifiers and short evidence lines redact userinfo, including passwords containing `@` | `repository.test.ts` checks short/long passwords against the entire database, edges and export; graph tests cover JS and Go |
| H1 quadratic import scanners | Go `import (` blocks found through one forward pointer and capped (20 000 chars); Python continuation capped (50 lines / 4 000 chars); lines > 4 000 chars skipped; evidence slice capped; per-import parse-time and per-file line budget (`parse_budget`) | `packages/domain/src/repository-graph.test.ts` "scanner cost is bounded" (256 KB inputs, < 1 s); found and fixed a 36 s case (`import "` flood) |
| M1 body limits | `hono/body-limit` on `/api` (`API_MAX_BODY_BYTES`, default 1 MiB; the archive upload keeps its own streaming limit) and on `/v1/*` (`GATEWAY_MAX_REQUEST_BYTES`), before any parsing, counted while the body streams (chunked without Content-Length covered) | `gateway-render-failure.test.ts` "streaming body limits" |
| M2 lockout | The account-wide failure bucket is now 100 / 15 min (was 10): failures from other clients can no longer lock the owner out; the tight bucket stays account+IP (5) and the per-IP bucket (30) stops spraying. `TRUSTED_PROXIES`: `X-Forwarded-For` is read only when the socket peer is a listed proxy, walking from the right | `auth-methods.test.ts`, `idempotency.test.ts` "client address" |
| M3 wallet challenge binding | A login challenge sets an HttpOnly, SameSite=Strict, Path-scoped cookie `wc_<challengeId>`; only its HMAC is stored (`wallet_challenges.binding_hash`, migration 015); session creation requires it | `wallet-binding.test.ts` |
| M4 memory injection | `inject=true` notes can be created, flagged or edited only by owner/admin; injected notes reach the provider as a **user-role** message, never `system` | `memory.test.ts` "injection right" |
| M5 operator | The decider may not belong to the target account; a review credit is capped by the reviewed transfer's computed value; rolling 24 h aggregate ceiling `OPERATOR_DAILY_LIMIT_MICROUSD` | `operator.test.ts` "deciders, review value and the daily ceiling" |
| L1 | Operator `reason`/`note` removed from the customer audit view | `operator.test.ts` "customer audit view" |
| L2 idempotency | `idempotency_keys.claim_token`: a stale in-flight claim reclaimed by another request invalidates the original; `completeIdempotent` fails (rolling its transaction back) when it updated no row | `idempotency.test.ts` |
| L3 test doubles | `GATEWAY_PROVIDER=fake`, `PAYMENT_ADDRESS_SOURCE=test`, `devCreditAccount` and `TestAddressProvider` need `ALLOW_TEST_COMPONENTS=true`, whatever `NODE_ENV` is; `loadConfig` refuses to start otherwise | `config` covered by every suite (vitest sets the flag); startup behaviour exercised by hand below |
| L4 secrets | `SESSION_SECRET`, `API_KEY_HASH_PEPPER`, `KEY_REPLAY_ENCRYPTION_SECRET` must be >= 32 characters; a shorter configured value aborts startup (it used to be silently ignored) | below |
| L7 | Malformed cursors are 400 on every paged list (bounds on date and id; the keys route used a private decoder that let a NUL reach PostgreSQL) | `cursor-errors.test.ts` |
| env names | API errors say "Service not configured" without naming the setting | `session.ts` |

Found by running against real PostgreSQL (`pg-real.test.ts`): migration `create table if not exists` race, and a reservation deadlock (request insert took a KEY SHARE lock on the account before `FOR UPDATE`). Both fixed.

## Known gaps (not fixed)

Recovered findings from the original independent review, retained as production limitations:

* **L5 — pairing-code abuse:** Telegram sign-in/connectivity pairing codes have 40 bits of entropy, and inbound ingestion has no per-sender attempt cap. The first sender who claims a disclosed code can bind the wrong chat. Real channel adapters remain unavailable; require sender rate limits and an explicit claimant confirmation before exposing them.
* **L6 — resource abuse and retention:** account creation can multiply deposit watches; expired challenge/auth-attempt cleanup and dust-review queue bounds need an operational policy and scheduled enforcement before public exposure.
* **L8 — Markdown export:** inert design exports escape HTML, but retain Markdown links/images. Any downstream Markdown renderer must sanitize output and control remote resource fetching; attachment headers do not govern a separate renderer.
* **L9 — import quotas:** per-project upload/retention/concurrency limits do not establish per-account or global storage quotas. Add those limits before hosting untrusted accounts.
* Operator access has no second factor beyond the sign-in methods (fresh authentication + a per-session elevation only).
* Rate limiters for challenges/sessions/keys are in-memory and per process. Persisted limits exist only for password/Telegram/key sign-in.
* Import analysis runs on the worker's event loop (bounded scanners and a time budget, no `worker_thread` CPU deadline).
* The embedded PGlite database is single-connection; production needs a networked PostgreSQL driver. Row locks and advisory locks are verified only through `pg-real.test.ts`.
* `OPERATOR_DAILY_LIMIT_MICROUSD` is advisory across different accounts (see reconciliation doc).
* Secret scanning of imported source is pattern-based and incomplete by design.
