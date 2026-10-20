# LLM gateway — full product specification (draft)

Status: **implementation authorized; local verification and independent review in progress**

The user subsequently authorized build, test, review and PR submission, and transferred the interrupted Claude Code implementation to Codex on 2026-10-19. Original planning-only language below records the draft's history; it does not revoke that authorization. Product proposals and external-service decisions remain explicitly unconfirmed where stated. Current implementation status and evidence live in [tasks/todo.md](tasks/todo.md). Fake adapters and embedded PostgreSQL verification do not establish live service or production readiness.

Reference observed: [human01 LLM](https://llm.human01.xyz/), 2026-10-18.

## Goal

Build a fully working, branded LLM gateway. Visitors can compare models and learn setup; customers can sign in, fund prepaid accounts, create controlled API keys, send compatible LLM requests, and inspect usage and costs. Scope includes the public site, guides, diagnostics, account console, API gateway, metering, prepaid ledger, wallet payments, and console optimization/project tools. The product must have its own visual identity, copy, graphics, and factual claims.

## Evidence and boundaries

The public reference homepage was loaded in desktop (1440 × 900) and mobile (390 × 844) Chromium. Its HTML and the public `/app`, `/setup`, and `/diag` pages were inspected. REA browser captures: desktop `ev_60f1026c27672f5c23056cad888d073f07bf8adb8b9863e9c82ca8730a25d9fa`, mobile `ev_aa242a26ab93e21b5c77c34d89bdf1a17297c73ffd61c0e483bf3ec8ce16a09f`, homepage DOM `ev_b538a9b917f02030ed7ddb75a066df768e61c76f1862f2eb2d3a762fe1845a87`; signed-out console `ev_e99e457230922e60f64436f76b3b1146ebf68fa640eca973cfb4321fec6c121f`, setup guide `ev_88109cead5baa8b03ec11ba9b2a9caaf230f91cdb3649fa118b2a26ca69602e4`, diagnostic entry `ev_cf81b00f8e977807abf2af873db5cf4100a152fdd1118bf2336eb70b903bf680`, and diagnostic sample after clicking its button `ev_3ac3dab923c04f3958de9ceaf7cd93acfec1dae8f9d02e1c016f6ea4f0b9d724`. These establish public appearance and the sampled interaction. Public console markup identifies screens and controls, but authenticated outcomes, API behavior, payment settlement, and beta internals were not observed. The functionality below is a proposed contract, not a claim about hidden reference behavior.

| Reference observation | Proposed treatment |
| --- | --- |
| Dark charcoal background, warm white type, muted secondary text, orange accent | Use the user's rickchen.si color reference with an original layout, typography, and icon language; select one visual concept before implementation. |
| Desktop hero has text and CTAs at left, an interactive feature card at right; mobile stacks them | Recreate this responsive hierarchy with our own explanatory feature content. |
| Homepage sections cover product overview, account controls, tool integrations, cost savings, model catalog, quickstart, wallet billing, and FAQ | Build these sections only where corresponding product facts and data exist. |
| Desktop top navigation; mobile sticky header, menu, and five-item bottom navigation | Design a distinct navigation pattern with keyboard access, clear active states, and safe-area spacing. |
| Model catalog has provider filters, search, price/context/capability columns, and click-to-copy model IDs | Make filtering and copy feedback functional; load catalog from an owned, typed data source. |
| Quickstart has Claude Code, Anthropic SDK, OpenAI SDK, and cURL tabs with copy buttons | Show correct examples for the endpoints actually supported by our product; use placeholder key text only. |
| Feature and savings diagrams have tabs and play/pause controls; FAQ expands inline | Build accessible manual controls; motion honors reduced-motion preference. |
| Public links lead to `/setup`, `/diag`, and `/app`; `/app` exposes a sign-in shell | Treat these as separate route scopes. A public shell does not prove working account, wallet, billing, or API flows. |

The reference nav includes an `#image-generation` link, but no matching section ID appeared in the fetched homepage HTML; its FAQ says image endpoints are unavailable. Image generation is not a parity requirement unless our own supported capabilities include it. No dead navigation item should ship.

### REA runtime verification status

| Flow | Current evidence | Next verification boundary |
| --- | --- | --- |
| Public catalog | `GET /v1/models` rendered a JSON model list without a sign-in in REA capture `ev_1f2a21aaf4fe897c4ee55922193b4fe1043657ac231b875e12507adde49bc417`. | Compare advertised model metadata with an authorized test request; a public list does not prove a model can run. |
| Signed-in console | Signed-out screen only: `ev_e99e457230922e60f64436f76b3b1146ebf68fa640eca973cfb4321fec6c121f`. | Attach REA to an authorized signed-in test browser; inspect overview, keys, usage, credits, and other scoped pages without exposing secrets. |
| Real API request and metering | No successful keyed request observed. | With a disposable test key, bounded budget, and approved model, observe one non-streaming and one streaming request and reconcile visible usage, request log, and balance. |
| Wallet authentication | No wallet was injected in the REA browser; it displayed a no-wallet message. | Use a dedicated test wallet/session to observe challenge, signature rejection and success, account creation/linking, session and replay behavior. Keep wallet private keys with the user. |
| Payment settlement | No transfer or authenticated credit view observed. | Use an authorized sandbox or a separately approved minimal test deposit; observe intent, chain confirmation, ledger credit, duplicate handling, and failure states. Do not move real funds without a reviewed amount/network/address and explicit approval. |

REA inspection of an external session must stay within the user's authorized test account. Public markup and successful `GET /v1/models` do not establish signed-in, billable, wallet, or settlement behavior.

## Product surfaces

### Pages

1. **Home (`/`)** — hero, gateway overview, benefits, integrations preview, model catalog, quickstart, billing explanation, FAQ, footer.
2. **Setup guides (`/setup`)** — searchable or categorized guides for supported tools. Each guide states tested status, prerequisites, endpoint, environment variables, and a copyable example. Reference guides also offer setup prompts and, for some tools, downloadable platform scripts; any such helpers in our product must be reviewable, preserve existing configuration, back up files before edits, and read keys through hidden input. Only label a guide tested after verification against our service.
3. **Usage comparison (`/diag`)** — sample report and local import of a customer's ZIP/CSV/JSON/JSONL usage export (25 MB input limit, plus decompressed ZIP limits), with schema validation, model matching, dated price assumptions, excluded items, download and print. The reference sample applies a 90% estimate only to matched provider spend and does not count unverified optimization claims. Our comparison must use an approved documented pricing rule, not inherit that promotional assumption. Imported data must stay on-device unless the user explicitly opts into upload.
4. **Account (`/app`)** — working sign-in, authenticated console, and deep links.
5. **API docs (`/docs`)** — endpoint schemas, streaming, compatibility, errors, limits, pricing rules, and changelog.

### Home interactions

- Header links scroll to real sections and account links navigate to `/app`.
- Language menu is included only if translated content is provided. Reference offers English, Simplified Chinese, and Traditional Chinese; translation must cover navigation, pricing notes, guides, FAQ, and errors, not just headings.
- Feature carousel and savings illustration support previous/next, direct tab selection, play/pause, and a stable reduced-motion state.
- Model catalog filters by provider, searches name/ID, shows a useful empty state, and copies an ID with visible and screen-reader feedback.
- Quickstart tabs switch code samples; copy buttons report success or failure. Examples never contain real credentials.
- FAQ rows expand with semantic `<details>` or equivalent accessible controls.
- Mobile menu opens and closes with clear focus behavior. Bottom navigation must not obscure page content.

### Content and data rules

- Product name, logo, text, provider relationships, model list, prices, context windows, free tiers, and availability are owned content. The reference's current “50 models” and dollar rates are observations, not launch commitments.
- Catalog entries use typed fields: `id`, `displayName`, `provider`, `inputPricePerMillion`, `outputPricePerMillion`, `contextWindow`, `capabilities`, `availability`, `pricingNotes`, `updatedAt`. Show source and update date for live prices.
- Label sample metrics and savings illustrations as examples. Do not claim automatic cache savings or route optimization without corresponding verified backend behavior.
- Copy snippets use a conspicuous placeholder such as `YOUR_API_KEY`; the browser never embeds a secret.

## Console functional scope

| Area | Required behavior |
| --- | --- |
| Overview | Real available/held balance, spend, recent requests, free-model availability, and connection examples. |
| Usage and logs | Time, model, key, project, status filters; request details with token categories, rate snapshot, and cost; pagination and CSV/JSONL export. Prompt content hidden by default. |
| Agent runs | Group requests into tasks when correlation data exists; show cost, cache, limits, and alerts. Missing correlation is shown as unknown. |
| Credits | Balance, holds, transactions, deposit intents, network/asset choice, payment status, vouchers if offered, and reconciliation history. |
| API keys | Main and team keys with one-time reveal, name, scope, per-key cap, last used, rotation, revocation, and audit trail. |
| Integrations | Account-specific setup guides and copyable snippets, using the selected key only within the authenticated browser session. |
| Connectivity | Pair/unpair supported notification channels (the reference shows Telegram and WhatsApp), alert settings, and recent delivery results. |
| Context steering and tuning | Explicit per-account controls for eligible optimizations, with privacy impact, opt-out, and applied/skipped evidence. |
| Project memory | Explicit save/edit/delete of short project notes with project isolation, retention controls, and evidence when a note is used. |
| Repository graph and Design beta | Working import, derived architecture view, and design workflow need separate detailed contracts. Public markup alone does not establish their backend behavior; keep behind feature flags until validated. |

The observed console also offers wallet, username/password, Telegram code, and API-key sign-in; overview, usage, logs, agent runs, credits, keys, integrations, connectivity, context steering, tuning, project memory, repository graph, and Design beta navigation. This table includes them all as scope, while the beta areas need more definition before code.

## Authentication, authorization, and accounts

- Wallet sign-in uses a short-lived, single-use, domain-bound signed challenge. EVM injected wallets and TRON wallets are reference-visible choices. Chain/account binding and replay protection are mandatory.
- Username/password and Telegram one-time-code sign-in require delivery, recovery, abuse limits, and explicit account linking. API-key dashboard access must not grant privileges beyond its owner.
- Use secure HTTP-only sessions, expiry/renewal, logout, and server-side authorization on every protected request. One customer may own multiple keys and projects; team keys cannot cross account boundaries.
- Secret keys are displayed once, stored only as verifiable digests, never hardcoded in examples or logged. Users can rotate and revoke them.

## Gateway and catalog contracts

- Publish compatible `GET /v1/models` model discovery. Publish provider/route, context limit, capabilities, availability, input/output/cached rates, long-context thresholds, restrictions and effective date through the owned `/api/catalog` schema. Keep rate versions for historical billing.
- Support tested Anthropic-compatible `POST /v1/messages`, OpenAI-compatible `POST /v1/chat/completions`, and `POST /v1/responses` for supported models. The reference also describes Gemini `generateContent`; include it only with a tested request/response contract and model matrix.
- Validate model/format compatibility and request size before forwarding. Preserve supported tool calls, streaming, usage data, and structured errors. Document unsupported fields and endpoints.
- Do not silently switch a requested model or route. Alternate routes are opt-in with compatibility and availability warnings. Bound retries so they cannot create duplicate billable execution.
- Enforce key scope, account/key spend caps, rate/concurrency limits, cancellation, and provider timeouts server-side.
- Prompt caching, concise guidance, route comparisons, batching, model matching, LoopGuard, and project context each need eligibility rules and applied/skipped evidence. Calculate savings claims from actual recorded usage and rate snapshots.

## Metering, prepaid ledger, and payments

1. Before execution, calculate and reserve a documented maximum cost. Reject insufficient available credits. Release unused holds after settlement or verified pre-dispatch failure; post-dispatch timeout follows the missing-usage reconciliation policy below.
2. Persist provider usage, price version, billable units, charge, adjustments, and request correlation in an append-only ledger. Settlement is idempotent; every balance change has a source and reason.
3. Show available and held balances separately. Document currency conversion and rounding. Console totals and exports reconcile to ledger records.
4. Configure only supported asset/network pairs. The reference lists USDT/USDC on Ethereum, BNB Chain, Polygon, and Arbitrum, and USDT on TRON. These are compatibility targets, not existing treasury support.
5. Create a deposit intent with amount, asset, network, receiving address, expiry, and unique correlation. Verify chain ID, token contract, destination, amount, required confirmations, and event identity before crediting.
6. Handle pending, underpaid, overpaid, wrong-network, expired, reversed, and manual-review states. Reconcile chain events with the ledger independently; never credit from a client-submitted transaction hash alone. Operator corrections need an audit trail and dual control.
7. If vouchers/promotions exist, enforce eligibility, expiry, redemption idempotency, and separate ledger entries.

## Diagnostics, optimization, and privacy

- Validate imported usage exports and preview recognized fields before processing. Show unmatched models and unknown rates separately. Comparisons use the same recorded token units and dated rates, with caveats for unsupported billing details.
- Store minimal request metadata by default. Prompt bodies, code, tool output, secrets, and private repository content require explicit opt-in, redaction, retention limits, and deletion controls.
- Show baseline versus actual optimization results only where comparable evidence exists; otherwise say “insufficient data.” Loop detection is advisory unless the user explicitly configures enforcement.
- Isolate memory and repository data by account/project. Users can inspect, edit, export, and delete stored data. Imported content is untrusted input.

## Design direction

Use the user-selected palette from https://rickchen.si/ with an original layout and identity distinct from the gateway reference. The three latest portfolio-palette dark console concepts are the current candidates; none is selected. After selection, extend the design to the public hero and mobile screens, which have not yet been designed. Each direction must support Light, Dark, and System modes with a visible theme control; System follows the device preference, and an explicit choice persists across sessions. Define both palettes, type, spacing, iconography, forms, data tables, charts, empty/error states, and responsive navigation. Dark mode must preserve contrast and distinguish statuses without relying on color alone. Keep credit amounts and prices especially legible. The primary console screen should foreground available credit, active key status, recent cost, and a clear first-request path; advanced optimization belongs deeper in navigation.

## Suggested system boundaries

| Boundary | Responsibility |
| --- | --- |
| Web app | Public pages, account console, setup guides, diagnostics UI, typed API client. |
| Identity service | Wallet challenges, credentials/OTP, sessions, authorization. |
| Gateway service | Request validation/translation, provider routing, streaming, limits, metering events. |
| Catalog/pricing | Capabilities, route availability, effective-dated rates, public catalog. |
| Ledger/payments | Holds, charges, credits, vouchers, chain watchers, reconciliation, audited corrections. |
| Usage workers | Logs, exports, cache/optimization evidence, diagnostics, alerts. |

Use a transactional store for accounts and ledger, a queue for asynchronous processing, and server-side secret management. Stack, cloud, custody, and chain provider choices remain open. This spec does not authorize production changes.

## Quality and acceptance criteria

- At 390 px and 1440 px, all approved sections are readable, no horizontal page overflow occurs, and fixed navigation leaves content reachable.
- Light, Dark, and System modes work across every public and console route without a flash of the wrong theme during initial load; charts, code blocks, forms, and payment states remain legible in each mode.
- Every visible control has a working action, keyboard focus, an accessible name, and a visible status or selected state.
- Reduced-motion users can use every carousel and diagram without automatic motion.
- Catalog filters and search yield the expected subset; copy actions return exactly the displayed ID/snippet.
- Internal navigation has no dead anchors or placeholder destinations.
- Prices and technical claims come from the approved product data and are labeled with their update date.
- Public pages render useful content without an account; account-only data requires authenticated authorization.
- A new customer can sign in, fund an account, issue a scoped key, complete both streaming and non-streaming requests, see matching ledger and usage results, rotate the key, and sign out.
- Insufficient funds, provider timeout, malformed request, duplicate payment event, chain mismatch, and revoked key each produce the documented result without incorrect credit or charge.
- A price update does not rewrite historical charges; filtered exports reconcile with console totals and ledger entries.
- Security review covers auth, secret exposure, provider abuse, wallet signing, payment crediting, audit logs, privacy, and operator permissions. Production release requires monitoring, backups, reconciliation alerts, and rollback procedures.

## Decisions needed before implementation

1. **Brand:** product name, logo ownership, languages, and selected visual direction.
2. **Gateway:** provider accounts, model catalog, supported formats/features, rate source, and which free or optimization claims can be proven.
3. **Payments:** wallet networks/assets, custody/treasury model, confirmation policy, payment infrastructure, and responsible operator.
4. **Operations:** hosting, database, queue, observability, secret management, environments, and regions.
5. **Beta tools:** exact behavior/data contracts for repository graph, design workflow, and agent insights before enabling them.

Deliver in reviewable slices: approved visual system/public pages; account and catalog; keys and gateway with metering; ledger and funded requests; wallet deposits/reconciliation; then diagnostics, optimization, connectivity, and project tools. The full scope remains the goal. No framework or deployment choice is fixed, and no implementation is authorized by this spec.

## Planning revision: decisions, modules, and delivery contract

Revision: **draft 0.2, 2026-10-18**. The user requested both specification and planning, so the accompanying [plan](tasks/plan.md) and [task list](tasks/todo.md) are review artifacts. Approval of a visual option, architecture, spending, deployment, or implementation has not been inferred. Existing reference evidence above is supplied from the earlier investigation; this revision does not independently verify authenticated behavior.

### Users and capability map

Primary users are individual developers funding model usage, account owners controlling team/project spending, and operators maintaining catalog accuracy and reconciling credits. Anonymous visitors can browse prices, guides, and local diagnostics. Operators use a separate privileged role; customer wallets confer no operator powers.

| Module ID | Responsibility | Depends on |
| --- | --- | --- |
| identity | Principals, linked sign-in methods, memberships, sessions | — |
| catalog | Versioned models, supported protocol matrix, rates | — |
| ledger | Available funds, reservations, settlement and adjustments | identity |
| keys | Scoped service credentials and budgets | identity |
| payments | Deposit intents, chain observation, confirmation, reconciliation | ledger |
| gateway | Protocol adaptation, limits, cancellation and billable execution | catalog, ledger, keys |
| reporting | Usage, exports, agent correlation and diagnostic comparison | gateway, ledger |
| automation | Opt-in optimizations, memory, repository and design tools | gateway, reporting |
| connectivity | Verified channel pairing and notifications | identity, reporting |
| web | Public pages and customer/operator workflows | interfaces of the modules above |

These are logical modules, not a requirement to deploy nine services. Proposed architecture is a modular TypeScript application with separate web, API/gateway, and worker processes; PostgreSQL is the authoritative transactional store. Start with a PostgreSQL outbox for durable jobs and add a dedicated queue only when measured load requires it. Redis may support transient limits; it must not own money or idempotency. This keeps transactional charging within one database while separating long-running streams and chain polling. Stack and host remain proposals for approval.

### Shared contract snapshot: draft-0.2

This section is the planning-stage canonical contract. Before parallel implementation, the backend owner must materialize it as `packages/contracts/openapi.yaml` and validated TypeScript schemas in `packages/contracts/src/`; frontend and QA consume the same committed snapshot. The coordinator owns acceptance of changes. Breaking schema changes must update consumers and fixtures together. `/api/*` is the first-party console API; `/v1/*` and any Gemini route preserve their published upstream-compatible shapes rather than the console envelope.

Common console types: IDs are opaque strings; timestamps are UTC RFC 3339; money is an integer decimal string in micro-USD (six fractional USD digits); token and chain amounts are nonnegative integer decimal strings. Never calculate money with binary floating point. Lists return `{items, nextCursor}` with stable `(createdAt,id)` ordering; `limit` defaults to 50 and is capped at 200. Errors return `{error:{code,message,requestId,fieldErrors?}}`; no provider secrets or internal traces are returned. Map malformed inputs to 400, missing authentication to 401, disallowed operations to 403, inaccessible resource IDs to 404, conflicting idempotency/version state to 409, semantic validation to 422, limits to 429 with `Retry-After`, and dependency failures to 502/503/504. Console insufficient funds uses 409 `INSUFFICIENT_FUNDS`; gateway adapters document the compatible equivalent.

| Interface | Request | Success and authorization |
| --- | --- | --- |
| `POST /api/auth/wallet/challenges` | `{protocol:'evm'|'tron', address, chainId}` | 201 `{challengeId,message,expiresAt}`; public, origin restricted and rate limited |
| `POST /api/auth/wallet/sessions` | `{challengeId,signature}` | 200 `{user,account,membership,expiresAt}` plus secure session cookie; single-use challenge |
| `GET /api/session` / `DELETE /api/session` | none | 200 session view / 204 logout; authenticated session |
| `GET /api/catalog` | provider/search filters | 200 public catalog plus pricing version; no provider credentials |
| `GET /api/accounts/current/balance` | none | 200 `{availableMicrousd,heldMicrousd,postedMicrousd,asOf}`; account member |
| `POST /api/keys` | `{name,projectId?,scopes,modelAllowlist,spendCapMicrousd?,expiresAt?}` | 201 `{key,secret}` once; owner/admin with recent sign-in |
| `GET /api/keys` / `DELETE /api/keys/{id}` | list query / none | metadata only / 204 revoke; owner/admin or explicitly delegated key manager |
| `POST /api/deposits` | `{asset,network,amountAtomic}` | 201 `{id,address,assetContract,network,amountAtomic,expiresAt,status}`; owner/billing role |
| `GET /api/deposits/{id}` | none | 200 intent, confirmation and credit status; same account only |
| `GET /api/usage` and `/api/ledger` | date/model/project/key/status filters, cursor | 200 page; member limited to granted projects, billing role for ledger |
| `POST /api/exports` | `{kind,filters,format:'csv'|'jsonl'}` | 202 `{jobId,status}`; only authorized rows, expiring download after completion |
| `GET /api/jobs/{id}` | none | 200 `{status,downloadUrl?,expiresAt?,error?}`; initiating account and scope |
| `POST /api/projects/{id}/memories` | `{text,expectedVersion?}` | 201 note with version; project editor, explicit storage consent |

All mutating authenticated console endpoints require CSRF/origin validation; cookies use Secure, HttpOnly and SameSite. Resource authorization is server-side, never inferred from URL IDs. Members can only see assigned projects; billing can fund/view ledger; admins manage users/keys; owner manages account recovery and high-impact permissions. Operator access is separately granted, audited and requires stronger authentication. Membership administration and privileged adjustments need complete schemas before their slice begins.

`Idempotency-Key` is mandatory for deposit intents, exports, ledger-affecting mutations and key creation. Persist `(account,operation,key,payloadHash,result)` atomically; same completed request returns its prior result, changed payload returns 409, in-flight duplicate returns 409 `IN_PROGRESS`. Secret-bearing key-creation responses are encrypted for a short replay window and require the same session; after that window return metadata and an explicit non-recoverable-secret status, never mint a second key silently. Ledger financial event IDs are retained permanently; other retention must exceed documented delivery/replay windows. Provider retries are forbidden after possible acceptance unless the provider supports a proven idempotency contract. Gateway requests use a server request ID and an optional customer correlation ID, never assume a retry is free.

### Identity and wallet behavior

EVM verification follows [ERC-4361](https://eips.ethereum.org/EIPS/eip-4361): parse the server-authored message, validate exact domain/URI, nonce, address, allowed chain, issued/expiry times, and signature. Signing is authentication, not a payment approval. The browser handles [EIP-1193](https://eips.ethereum.org/EIPS/eip-1193) account/chain changes by discarding the pending challenge; rejected signing returns to a usable sign-in screen. Contract wallets require a separately tested verification policy before being advertised; do not treat an unverified contract wallet as an EOA.

TRON uses its own domain-bound canonical message with `signMessageV2` and server verification/recovery as described by [TronLink](https://docs.tronlink.org/dapp/message-signing/). SIWE does not apply to TRON. Challenges expire after five minutes, are single-use and consumed atomically during session creation; invalid attempts are limited. Address identity includes protocol and chain policy. Wallet linking requires a current account session plus a new proof; never merge accounts automatically based on matching text addresses. Unlinking the last recovery method requires an alternative first. Lost-wallet recovery and account deletion are product decisions, not operator discretion.

All reference-visible sign-in methods remain in full scope: password credentials use an approved password hash, generic failure responses and verified recovery; Telegram login verifies server-issued single-use codes through the bot; API-key console entry is a restricted session limited to the key's existing data scope. It cannot view secret keys, link identities, change account security, create privileged keys or initiate withdrawals/adjustments. Wallet/password/Telegram owners step up before privileged mutations. Payment handling and login are independent: signing into a wallet does not prove a deposit.

### Data and financial invariants

Minimum entities: User, Account, Membership, LinkedIdentity, Session, Challenge, Project, ApiKey, Model, Route, PriceVersion, Request, UsageRecord, Reservation, LedgerTransaction, LedgerEntry, DepositIntent, ChainEvent, ExportJob, AuditEvent, OutboxEvent, NotificationBinding, ProjectMemory and ImportJob. Each customer-owned entity carries `accountId`; relational constraints and authorization tests enforce isolation. No persisted API key plaintext; provider keys use secret storage. Ledger transaction IDs reference source requests/deposits and immutable price snapshots.

Use balanced double-entry postings for credits, spend and adjustments; available balance equals posted customer funds less active reservations. Reservation creation atomically checks both account balance and applicable key/project budget under row locks or serializable transactions. Two concurrent requests cannot spend the same available funds. Round the final charge once, upward to micro-USD after exact rate multiplication; show smaller estimates without converting them into charged amounts. Cached and uncached token categories must not overlap. Reserve using the route's proven upper-bound tokenizer/limits and requested output cap; reject a route when safe estimation is unavailable. Apply a default bounded output cap when omitted and document it.

Request state: `VALIDATED → RESERVED → DISPATCHED → SUCCEEDED|FAILED|CANCELLED|USAGE_PENDING → SETTLED`. Failures before dispatch release the reservation immediately. A disconnect after dispatch can still incur provider charges; cancel upstream where supported and settle actual verified usage. Missing usage goes to `USAGE_PENDING` with reconciliation, not an assumed zero charge or unlimited hold. Proposed policy: reconcile within 24 hours, then release the customer hold, absorb unresolved provider cost and do not silently charge later. Confirm this commercial policy before launch. Partial stream errors emit protocol-compatible error events and close the stream; never append an ordinary JSON response to an SSE stream.

Deposit state: `CREATED → DETECTED → CONFIRMING → CREDITED`, with `EXPIRED`, `REVIEW_REQUIRED` and `REVERSED` branches. Deduplicate by `(network,transactionHash,eventIndex,assetContract)`; transaction hash alone is insufficient for multiple transfers. Amounts use the configured token's decimals. Credit only finalized, matched events; a chain reorganization after credit produces an auditable compensating transaction and account review, not deletion of history. Do not automatically spend an ambiguous underpayment, wrong network or unmatched transfer. Overpayment, expiry grace and confirmation count per asset/network must be approved configuration. MVP has no withdrawals or exchange service; treasury refunds, if allowed, require an explicit reviewed operations policy. Wallet keys are never handled by the frontend or stored in the application database.

### Gateway compatibility and remaining feature definitions

The acceptance matrix must cover each advertised `(provider, model, protocol)` tuple, for streaming/non-streaming, tools, JSON output, context limits, cancellation, usage categories and errors. OpenAI Chat Completions, Responses, Anthropic Messages and Gemini generateContent are distinct adapters. Gemini is full-scope only when a provider/model has passed its adapter tests; unavailable combinations are explicitly disabled, never silently translated. Unsupported parameters fail clearly. Public `/v1/models` follows the selected compatibility schema; expanded prices and routing details live in `/api/catalog` to avoid inventing incompatible required fields.

Agent runs group caller-supplied `projectId/runId/parentId` metadata after authorization; no invented inference of hidden agent actions. Export and diagnostic totals use the same usage records. Diagnostics parse ZIP/CSV/JSON/JSONL locally by default (25 MB input limit matching the public reference; enforce decompressed-size and file-count limits for ZIP), protect CSV exports against formula execution, report unknown columns/models, and never fetch imported URLs. A comparison is an estimate using a named price snapshot, not a promise of savings.

Optimization controls must be individually enabled and reversible: prompt-cache accounting reflects provider-reported cached tokens; concise guidance/context injection previews changes; route comparison is informational until explicitly enabled; batching exposes its queue/latency tradeoff; LoopGuard begins advisory and enforcement requires a threshold plus explicit consent. Track original/applied policy version without retaining prompt bodies by default. Project memory is explicit notes, versioned edits, scoped injection and inspectable usage; no automatic ingestion of private material.

Repository graph proposal: user-uploaded repository archive, validated file/size limits, no execution of repository code, exclusions for secrets/vendor/generated content, read-only import job, dependency graph with source file/line evidence and delete/export controls. External URL cloning is deferred until SSRF/credential handling is designed. Design beta proposal: project brief → generated proposal → user revisions → exportable artifact; model calls are metered, generated output is labeled, and no generated code is executed or deployed automatically. These proposed definitions require confirmation; hidden reference implementation is unknown. Keeping a beta flag off does not satisfy completion of the user's full product scope.

Telegram and WhatsApp connectivity require verified account pairing, revoke/unpair, delivery status and event preferences; message content contains minimal metadata and no keys/prompts. Sending real messages requires service credentials and user consent. Credits/vouchers, alerts, account recovery, customer data deletion and operator reconciliation require real backend workflows before being marked complete.

### Design acceptance and operational targets

The previously generated three light and three dark console overview layouts were exploratory. Three revised dark console candidates now use the portfolio palette: editorial ledger, technical request workspace, and spend board. None is selected. Their earlier palettes are superseded by the user-selected portfolio colors; public hero/mobile screens and the revised light companion remain pending. A designer must map the selected concept to homepage, sign-in, overview, keys, request detail, deposits and payment failure states at 390 and 1440 px. Include first-use, empty, loading, pending, stale, validation, unauthorized and offline/retry states. Light/Dark/System is required across all routes; persist explicit choice and follow live system preference only in System mode. Target WCAG 2.2 AA, visible keyboard focus, semantic tables, labeled charts, status text independent of color and reduced motion. No copied gateway reference brand or fabricated testimonials. The dark charcoal/gold color family is now an explicit user preference, based on their portfolio.

Proposed performance budgets: public LCP ≤2.5 s, CLS ≤0.1 and INP ≤200 ms measured with a declared device/network profile; console list API p95 ≤500 ms excluding provider/chain time; gateway p95 added time to first upstream dispatch ≤150 ms at 50 concurrent requests in staging. These are acceptance targets, not measured results. Initial load assumptions: 1,000 accounts, 50 concurrent generation requests, 100,000 usage records/day. Reassess before infrastructure sizing.

Operational acceptance includes redacted structured logs, trace/request IDs, alerts for negative balance, stuck reservations, chain lag, reconciliation mismatch and provider failures. Proposed backup objectives are RPO ≤15 minutes and RTO ≤4 hours, verified in a restore exercise. Retention proposal: operational request metadata 30 days, explicit prompt capture off by default and at most seven days when enabled; financial retention and deletion exceptions need the operator's jurisdiction/policy decision. No legal retention duration is assumed. Export/delete account content while retaining only required financial records with documented access restrictions.

### Acceptance journeys

| ID | Observable journey and required evidence |
| --- | --- |
| A1 | Visitor filters actual catalog, copies a valid example and follows setup; all links work in both themes on mobile/desktop. |
| A2 | New EVM and TRON users sign in separately; wrong domain/chain, expired/replayed/rejected signatures fail safely; account linking cannot take over another account. |
| A3 | Customer funds a supported network, sees confirmation progress, receives one credit for duplicated delivery; wrong asset/network and reorganizations enter documented states. |
| A4 | Customer creates a key, runs stream and non-stream requests, sees one reconciled charge; revocation prevents subsequent requests and cross-account reads fail. |
| A5 | Concurrent near-balance requests cannot overspend; timeout/disconnect/missing usage reconcile according to the declared billing policy. |
| A6 | Price changes preserve prior charges; console, filtered exports and ledger totals reconcile exactly. |
| A7 | Password, Telegram and restricted API-key sign-in honor their recovery and privilege boundaries; session expiry returns a usable sign-in flow. |
| A8 | Customer imports diagnostic data, configures optimization, groups agent runs and edits memory; unknown data is labeled and project isolation holds. |
| A9 | Repository import produces evidence-backed graph; design workflow produces a reviewable export; deleting imports removes their stored content. |
| A10 | Operator can reconcile a missing event, approve an adjustment with a second authorized operator, restore backup and execute rollback in staging. |

### Commands, ownership and review boundary

The checkout currently has no application scaffold or test scripts. Proposed commands to establish in the foundation slice are `pnpm install --frozen-lockfile`, `pnpm dev`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:integration`, `pnpm test:contract`, `pnpm test:e2e`, and `pnpm build`. They are not runnable verification claims today. Pin supported toolchain versions when implementation is approved. Use strict TypeScript, runtime boundary validation, explicit discriminated state unions and typed errors; never use floating point for charges or embed secrets.

Proposed layout: `apps/web`, `apps/api`, `apps/worker`, `packages/contracts`, `packages/domain`, `db/migrations`, `tests/integration`, `tests/e2e`, and `docs/operations`. Backend owns schemas/migrations/contracts; frontend owns pages/components; QA owns independent integration/E2E acceptance; release owns approved deployment and runbooks. Avoid concurrent writers to shared contracts or migrations. Test database transactions, replay protection and financial races at integration level; test each external adapter against fixtures and authorized sandbox/live checks; use browser tests for complete customer journeys, accessibility and visual states. No percentage coverage goal substitutes for these invariants.

Always preserve unrelated files, label mock data, verify claim sources, and run relevant checks when implementation exists. Ask for product decisions that affect money, custody, providers, identity recovery or the chosen visual concept. Never begin implementation, create paid resources, transfer funds, deploy, or expose credentials under this spec/plan-only authorization. Future implementation follows repository signed-commit/PR requirements once explicitly requested.

### Confirmed user decisions and palette evidence

The user selected https://rickchen.si/ as the color reference and confirmed that provider accounts and wallet/payment setup do not yet exist. The plan includes evaluating, selecting and preparing these integrations; actual account provisioning, credentials, treasury setup and production actions require later authorization. Layout among the console concepts remains open.

The coordinator fetched and visually inspected the portfolio on 2026-10-18. Its [served CSS](https://rickchen.si/assets/portfolio.css?v=20261014-folder-motion) defines dark tokens: background `#202225`, surface `#25282d`, bar `#2b2e34`, inset `#292e36`, text `#f0f2f5`, muted `#b5bfce`, border `#49525f`, accent `#dfbb76`, connector `#aa8c56`, button `#dfb66d`, button text `#272017`, key/link accent `#8bc9ed`, success `#48bb78`. These become the dark design starting point; all semantic combinations still need contrast checks. The source declares a dark color scheme. Create and validate a complementary light palette rather than claiming a supplied light theme. Light/Dark/System remains required.

The reference audit also confirms that public diagnostics advertise local ZIP/CSV/JSON/JSONL processing up to 25 MB, sample/download/print flows and unknown-model handling. Its savings estimate is promotional, not verified billing behavior; our calculations must derive from actual approved rates. Public setup guides distinguish real-tool tested, API-format checked and documentation-only status; preserve this honesty in our own guide status labels. EVM/TRON login and supported deposit networks are public reference claims, not evidence of successful authentication or settlement.
