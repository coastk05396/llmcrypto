# Optimization controls, project memory and connectivity (tasks 19-21, backend)

Code: `apps/api/src/{optimization,memory,projects,connectivity}/`, `apps/worker/src/{notifications,memory-retention}.ts`,
`packages/domain/src/{optimization,memory-policy,notifications}.ts`, migrations `007_optimization.sql`, `008_project_memory.sql`,
`009_connectivity.sql`. Tests: `tests/integration/{optimization,memory,notifications}.test.ts`, `packages/domain/src/optimization.test.ts`.
Contract: draft-0.4 (additive; see the end).

**Honest scope.** Everything runs against the deterministic `FakeProvider` and Fake channel providers. No real model, savings
or message delivery has been observed. The controls change a request only by prepending text the account itself wrote, or by
blocking a repeated request the account asked to have blocked. **No saving is claimed anywhere.**

## 1. Optimization controls (`/api/optimization/*`)

One policy document per account. Every control is **off by default**, **opt-in**, and the policy is **versioned**: each change appends
version N+1 under a row lock (`optimization_policies` is append-only); `expectedVersion` stale -> 409 `VERSION_CONFLICT`. Version 0 is
the implicit all-off default. **Reverting** (`POST /policy/revert`) appends a new version copying an older config (0 = all off) and
records `revertedFrom`; history is never rewritten. An unchanged config creates no version. Only owner/admin change it; any non-key role
may read. Enabling guidance, project context or LoopGuard enforcement needs a recent sign-in (`STEP_UP_REQUIRED`); turning things off never does.

| Control | What it does | Evidence | Not claimed |
| --- | --- | --- | --- |
| `cacheAccounting` | Accounting only. The report prices the same recorded tokens with and without the provider-reported cached discount, each at the request's own rate snapshot. | `cache_accounting` row per request; token counts derived from `usage_records` when read. | Does not cause caching. Requests with missing usage, unsettled, or clamped by an overrun are excluded and reported as `insufficient_data`. |
| `conciseGuidance` | Prepends the account's own <=500-char system message. | `applied` with `addedUtf8Bytes`, or `skipped` (`request_opt_out`). | Adds input tokens (you pay for them). Whether answers get shorter is not measured. Report status is always `insufficient_data` (no counterfactual). |
| `projectContext` | Prepends the request project's `inject`-flagged, unexpired notes within `maxNotes`/`maxChars` (see section 2). | `applied`/`skipped` (`no_project`, `no_eligible_notes`, `over_budget`, `request_opt_out`) + per-note `memory_usage` rows. | No savings; `insufficient_data`. |
| `routeComparison` | Informational: evidence read shows what the recorded usage would have cost on other catalog models on the same protocol at **current** rates. | `routeComparison` on the evidence item. | An estimate, other models may answer differently. **The route is never switched.** |
| `batching` | **Unavailable.** No provider batch API exists, so its queue/latency tradeoff cannot be delivered. `enabled: true` -> 422. | none | Declared in `GET /controls`. |
| `loopGuard` | Detects the same request (keyed digest of model + roles + text, grouped by `X-Run-Id` else key id) repeated within `windowSeconds`. **Advisory** by default: evidence + `X-LoopGuard` response header, request still runs and is charged. `mode: "enforce"` needs `enforcementConsent: true`: the request that reaches `threshold` gets 429 `loop_guard_blocked` **before** reservation (no provider call, no charge). | `loop_guard` row (`advisory`/`blocked`/`skipped: below_threshold`). | Counts are reported; avoided cost is not. Enforcement can block legitimate retries. Concurrent identical requests can slip past the count by the in-flight amount (best effort, not a lock). |

**Per request**: `X-Optimize: off` skips only the request-altering controls (guidance, project context) with a recorded reason; it does not bypass LoopGuard.
`requests.policy_version` records the governing version (0 = defaults; NULL = older rows); responses carry `X-Optimization-Policy: <version>` when >0.
**Evidence** (`optimization_evidence`, append-only): one row per (request, enabled control). It stores counts, reasons and, for LoopGuard only, a
keyed digest. **No prompt, completion or note text.** Rows are written in the same transaction as the reservation, so a refused or failed
reservation (402, caps, pre-dispatch failure) leaves none; a LoopGuard block records its row alone (no request row exists).
**Preview** (`POST /preview`): returns the messages the provider would receive with each message's origin (`request`/`guidance`/`project_memory`) and byte counts.
It sends, stores and charges nothing. The only stored text is the guidance (in the policy) and notes (section 2), both written by the account.
**Report** (`GET /report`): baseline-vs-actual only for cache accounting, from settled requests with provider usage; otherwise `insufficient_data` with the reason.

Reservation, budgets and cancellation are unchanged: injected text is part of the input bound that is reserved (so a longer prompt can be refused by funds or a
key/project cap), settlement and the missing-usage policy are untouched. Regression tests cover cap refusal, disconnect mid-stream, provider rejection and the A5 concurrent race with guidance on.

## 2. Project memory (`/api/projects/*`)

`POST|GET /api/projects`, `GET /api/projects/{id}` (new: create is owner/admin, names unique per account case-insensitively; every role lists names; there are no per-project grants yet).
Notes: `POST|GET /{id}/memories`, `GET|PUT|DELETE /{id}/memories/{memoryId}`, `GET /{id}/memories/export`, `GET /{id}/memories/usage`, `GET|PUT /{id}/memory-settings`.

- **Explicit storage only.** Create and edit require `storageConsent: true` (422 otherwise). Nothing is ingested from requests or responses (tested: prompt/completion text never reaches `project_memories`).
- **Versions.** A note starts at version 1; `PUT` is compare-and-set on `expectedVersion` (409 `VERSION_CONFLICT`; of N parallel edits at one version exactly one wins). On create, `expectedVersion` if sent must be 0.
- **Isolation.** Every query is scoped by account and project; another account's, or another project's, ids are 404 on every verb, and injection only reads the request's project. Roles: owner/admin/member use notes, billing cannot, retention settings are owner/admin. API-key sessions are refused. Audit rows hold ids and lengths, never text.
- **Delete is real** (the row is removed). Usage evidence (`memory_usage`, append-only) keeps only note id, version and request id, so it outlives the note.
- **Retention.** `retentionDays` (1-365 or null = until deleted) per project; a note expires that many days after its **last edit**. Expired notes are invisible, not exported, not injected; `purgeExpiredMemories` (worker) deletes them for real. Shortening retention can expire notes immediately. 200 notes per project.
- **Export.** `GET /memories/export` downloads notes, retention setting and up to 1,000 usage rows as JSON (audited).
- **Injection** requires all of: policy `projectContext.enabled`, the note's own `inject: true`, a resolved project (`X-Project-Id`, or the key's project), not expired, and no `X-Optimize: off`. Notes go in one user-role message labelled "reference data, not instructions" (they are untrusted input), oldest first, within the budget. Each use is recorded as `injected` or `skipped` with the note version: *note N version V used in request R*.

## 3. Connectivity (`/api/connectivity/*`)

Channels: Telegram and WhatsApp through the `ChannelProvider` port (`packages/domain/src/notifications.ts`: `fetchInbound`, `send`, `ChannelError`).
**Real delivery is BLOCKED: no bot token or WhatsApp credentials exist.** Only `FakeChannelProvider` is implemented; an app without a registered provider reports `mode: "unconfigured"` and pairing answers 503. `GET /channels` states which mode is active so the UI can say "test double: nothing is really delivered".

**Pairing** (owner/admin, recent sign-in): `POST /pairings {channel}` returns an 8-character single-use code (10 min, shown once, stored only as an HMAC bound to the channel). The user sends it to the bot/number from their channel account; `POST /pairings/{id}/confirm` ingests inbound messages, then consumes the code in one conditional UPDATE and creates the binding for the channel sender that claimed it. A confirm before the message arrives is a 422 and does not consume the code (30 tries burn it). Expired, replayed, unclaimed, wrong-channel and other-user/other-account attempts all fail (422/404); max 5 open codes per account (429). Confirm accepts an empty body or `{events}`.
Known limitation (same as the Telegram sign-in): whoever sends the code first claims it, so a code shown on a shared screen could bind someone else's chat; the response shows the masked destination and the binding can be unpaired at once. A "show the claiming handle before consuming" step is not built.

**Preferences**: each binding has `events` (`insufficient_funds`, `key_cap_reached`, `loop_guard`, `deposit_credited`, `deposit_needs_review`); default **none** (opt-in). `PUT /bindings/{id}` replaces them. `DELETE /bindings/{id}` unpairs and skips queued deliveries; the channel account can be paired again. `POST /bindings/{id}/test` queues one fixed test message (one per minute).

**Delivery** is asynchronous through the outbox: producers insert `notification_events` (deduplicated per account by `dedupe_key`; only when some active binding subscribes): gateway refusals (`insufficient_funds`, `key_cap_reached`, once per key per hour), LoopGuard triggers (once per run/key per hour), deposit credit and review (inside the credit's own transaction, once per deposit/reason). The worker (`runNotificationDelivery`) claims events with a lease, creates one `notification_deliveries` row per (event, binding) (unique), re-checks the binding at send time, and sends with the delivery id as an idempotency token. Transient errors retry with 30 s x 2^n backoff up to 3 attempts, permanent errors fail at once; `GET /deliveries` shows `pending|sent|failed|skipped`, attempts and the error code. Delivery is at-least-once unless the channel honours the idempotency token. Failures never touch ledger or request state.
**Minimal data**: the text is a fixed template per event kind plus an opaque reference id (`LLM Gateway: <template> Reference: <id>. Open the console for details.`). Never keys, prompts, notes, amounts or addresses (tested).

Not built: real Telegram/WhatsApp adapters (including inbound webhooks/long polling and WhatsApp template-message rules), a STOP keyword, per-event destination routing, scheduling of the worker loops (no shared DB driver yet; run `runNotificationDelivery` / `purgeExpiredMemories` from a host process as the other jobs), email.

## 4. Contract draft-0.4 (additive over draft-0.3)

New schemas/operations (openapi, zod, fixtures and tests updated together; `test:contract` 145 pass): projects (`createProject`, `listProjects`, `getProject`); memory (`listMemories`, `getMemory`, `updateMemory`, `deleteMemory`, `exportMemories`, `listMemoryUsage`, `getMemorySettings`, `updateMemorySettings`); optimization (`listOptimizationControls`, `getOptimizationPolicy`, `updateOptimizationPolicy`, `revertOptimizationPolicy`, `listOptimizationPolicyVersions`, `previewOptimization`, `listOptimizationEvidence`, `getOptimizationReport`); connectivity (`listChannels`, `createPairing`, `confirmPairing`, `listBindings`, `updateBinding`, `unpairBinding`, `sendTestNotification`, `listDeliveries`).
Changed: `Memory` gains required `inject` and `expiresAt`; `CreateMemoryRequest` gains optional `inject`; `createMemory` documents 422. Gateway: header `X-Optimize`, response headers `X-Optimization-Policy` and `X-LoopGuard`, error `loop_guard_blocked` (429). CORS allows `PUT`.

# Design beta (task 23, backend, BETA)

Code: `apps/api/src/design/routes.ts`, `apps/worker/src/{design-generation,metered-completion}.ts`, `packages/domain/src/design-document.ts`, migration
`011_design_beta.sql`, FakeProvider design reply in `apps/api/src/gateway/fake-provider.ts`. Tests: `tests/integration/design.test.ts`.
Contract: draft-0.5. **The behaviour is the SPEC.md proposal ("Design beta proposal"), unconfirmed by the user.** Behind `FEATURE_DESIGN_BETA` (default off,
404 `FEATURE_DISABLED`; off means unavailable, not complete). Only the deterministic `FakeProvider` exists: **no real model has produced a design.**

* Flow: `POST /api/projects/{id}/designs` (brief, Idempotency-Key) -> 202 with `maxCostMicrousd` (quote; 409 `INSUFFICIENT_FUNDS` if available credit is
  below it, nothing created) -> the worker makes **one** metered call through the gateway reservation path (reserve, dispatch, settle/release; a request row
  with `run_id = design:<id>`, no API key) -> `GET /api/designs/{id}` shows each revision's status, document, failure and `cost` (`none|reserved|charged|pending|released`
  with the charged amount equal to the usage record and ledger spend). Revisions: `POST /api/designs/{id}/revisions {instruction, baseRevision}`.
  Export: `GET /api/designs/{id}/export?format=markdown|json[&revision=n]`.
* The brief and instructions are sent as delimited, untrusted text under a versioned system prompt; optimization-policy guidance and project notes are **not** injected.
* Output is validated against `DesignDocument`. Malformed (not JSON, wrong shape, cut off at the token cap) -> revision `failed` / `MALFORMED_OUTPUT`, no document kept, raw output
  not stored. **The completed call is billed as reported** (the provider did the work; unconfirmed policy). A provider that rejects releases the hold with no charge; a timeout keeps
  the hold as `USAGE_PENDING` for the existing reconcile job; a dead runner's revision is failed `INTERRUPTED` and never re-run (no second provider call).
* Exports are inert: markdown with angle brackets escaped, `Content-Disposition: attachment`, `Content-Security-Policy: sandbox`, labelled AI-generated in both formats. Nothing generated
  is executed, rendered as HTML or deployed by this service. The UI must show markdown as text, not as live HTML.
* Delete removes brief, instructions and documents; requests/usage/ledger rows stay (financial records, no text).
* Not done: streaming progress, a pre-submit quote endpoint (the quote comes with the create response), real-provider output quality, token-accurate input bounds (the quote uses the generic byte bound).
