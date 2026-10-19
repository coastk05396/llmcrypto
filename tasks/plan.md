# Full-product implementation plan — draft 0.2

Status: implementation authorized by the user's subsequent build/test/review/ship request; interrupted Claude work transferred to Codex on 2026-10-19. Implementation, local validation and signed PR submission are in scope. Production deployment, paid resources, live payments and unresolved integration/policy decisions remain outside that authorization. Earlier planning-only statements below describe the original draft. Source of truth: [SPEC.md](../SPEC.md) and the current shared contract in `packages/contracts`; task status lives only in [todo.md](todo.md).

## Decisions and unresolved inputs

Agreed scope is the complete public website, customer console, identity, funded API gateway, billing/payments, diagnostics, optimization, connectivity and project/beta tools. The visual style differs from the gateway reference. Colors follow the user's https://rickchen.si/ palette; light/dark/system modes are required. Three console layout candidates remain unselected. Public hero and mobile design extensions remain to be produced after selection.

Proposed architecture is strict TypeScript, a web application, an API/gateway process, a background worker and PostgreSQL with an outbox. This is a recommendation, not a selected deployment stack. Keep ledger mutations transactionally colocated. Do not begin with independent network services for each module. Existing checkout has no application/test scaffold; all commands in the spec are proposed future scripts.

Provider accounts and payment setup do not exist. Before implementation of their integrations, choose provider/model access, supported formats, pricing source, treasury/custody approach, network/asset pairs, confirmation rules and operator ownership. Compare direct provider accounts with an aggregator for coverage, usage accuracy, cancellation/idempotency, terms and margin. Compare managed deposit processing with an owned watcher for custody, reconciliation control, fees and operational burden. Record the decision and sandbox procedure before provisioning. Do not invent working credentials or an existing wallet.

Other open decisions: product name/languages, selected layout, identity recovery, contract-wallet support, missing-usage billing policy, retention jurisdiction, hosting/region and beta-tool proposed behavior. Full completion requires all scoped features; feature flags support staged delivery and do not count disabled features as complete.

## Reference runtime verification

The spec's REA evidence table separates observed public behavior from unverified signed-in behavior. Public `GET /v1/models` was observed; a successful keyed generation, wallet sign-in, console billing data, and deposit settlement have not been observed. An authorized signed-in test browser is the next read-only input. Attach to its loopback CDP target, select the exact human01 tab, capture one route/interaction at a time, and retain REA Evidence IDs, limitations, and a finding ledger. Do not read or export API-key values, cookies, prompt bodies, or wallet secrets.

After the user provides a disposable test key and per-request budget, separately scope one streaming and one non-streaming API call and compare request, usage, and balance evidence. Wallet challenge/signature tests require a dedicated test wallet and the user's control of signing. A settlement test requires sandbox access or explicit review of a real transfer's network, asset, amount, address, and irreversible effect. Until each access path exists, keep the corresponding parity claim unverified rather than treating static code or sample data as execution evidence. Findings may revise feature contracts before build tasks are dispatched.

## Dependencies and owner contracts

| Order | Deliverable | Owner | Depends on | Gate |
| --- | --- | --- | --- | --- |
| 0 | Decision record, provider/payment shortlist, selected layout and palette extension | planner + designer | User decisions | Spec and plan approved; risk-bearing policies explicit |
| 1 | Toolchain and shared schema snapshot | backend + frontend; backend sole contract writer | 0 | Build/type checks and schema fixtures |
| 2 | Public catalog, guides and accessible themed shell | frontend | 1, approved design | A1 mobile/desktop review |
| 3 | Wallet identity, accounts, memberships and scoped keys | backend, then frontend | 1 | A2 + authorization and replay tests |
| 4 | Transactional ledger and deterministic fake-provider request flow | backend | 3, catalog | Concurrency, settlement and failure tests |
| 5 | First real provider protocol and funded customer journey | backend + frontend | 4, authorized provider setup | A4–A6 sandbox evidence |
| 6 | Confirmed deposit/reconciliation workflow | backend + frontend | 4, authorized payment setup | A3 event replay/reorg tests and sandbox transfer |
| 7 | Remaining protocol matrix, auth methods, reporting and operators | backend + frontend | 5–6 | A7, export reconciliation, operator segregation |
| 8 | Diagnostics, optimization, notifications, memory and beta tools | backend + frontend | 7, approved feature contracts | A8–A9 privacy/isolation/usage evidence |
| 9 | Independent security/quality review and staging recovery | QA + independent reviewers | All prior slices | A1–A10 complete; findings resolved |
| 10 | Release preparation and separately authorized production release | release engineer | 9 | Monitoring, backups, rollback, approved real transaction checks |

Use vertical slices: a key or deposit task includes its schema/API/UI journey before proceeding, after narrowly scoped foundation tasks. Every task is limited to roughly 3–5 files; split an oversized integration before dispatch. The backend owns `packages/contracts` and `db/migrations`, frontend owns `apps/web`, worker/backend owns `apps/api`, `apps/worker`, `packages/domain`, QA owns tests. Coordinator resolves shared-file edits. Freeze the reviewed contract commit for each frontend/backend pair, with example success/error fixtures and all status/auth semantics. Do not parallelize consumers against an undefined schema.

Safe parallelism: approved public design implementation and identity backend; protocol adapters after the first adapter contract; read-only review and browser QA after code freezes. Sequential: ledger before billable gateway, deposit schema before watcher, API snapshot before generated clients, design selection before visual production work. Never assign two writers to one migration or shared contract file.

## Verification strategy and gates

Use pure unit tests for prices, parsed messages and state transitions; PostgreSQL integration tests for balance locks, duplicate consumption and account isolation; provider contract fixtures for streaming/tool/error formats; sandbox checks for actual external behavior; browser tests for complete customer journeys. Test fake providers explicitly as fake. Live compatibility and deposit support must not be claimed from mocks. If service credentials are unavailable, report those acceptance items as blocked.

After each 2–3 tasks, run their focused tests plus types/build where applicable and review the journey. Before crossing monetary gates, independently review invariants and replay/concurrency evidence. Final review must produce APPROVED/REJECTED with file evidence. Include browser visual/computed checks in both themes at 390 and 1440 px; include keyboard, reduced-motion and rejected wallet-signature states. Proposed performance and backup targets in the spec must be measured in the declared staging environment.

## Risks and mitigations

| Risk | Impact | Planned response |
| --- | --- | --- |
| Reference hidden behavior cannot be established | Incorrect parity claims | Maintain observed/proposed/unknown distinctions; approve explicit beta contracts |
| Provider usage missing after stream disconnect | Incorrect charge or indefinite hold | Early timeout/reconciliation spike; explicit bounded customer policy |
| Chain event replay/reorganization | Double credit or unbacked balance | Durable event identity, finality configuration, compensating entries, reconciliation |
| Concurrency across account/key budgets | Overspend | One transaction and authoritative locks; adversarial integration tests |
| Incompatible API translation | Broken SDKs or tool calls | Model/protocol matrix, actual SDK sandbox checks, clear unsupported errors |
| Provider/payment setup absent | Fake completeness | Selection/preparation tasks followed by separately authorized sandbox setup |
| Unselected visual layout and light palette | Rework | Design gate before frontend production styling |
| Broad beta-tool scope | Incomplete user goal | Explicit contracts and acceptance slices; never call disabled features complete |

## Delivery boundary

This turn produces specification and plan documents only. No executable app or verified live service is delivered. After user approval to build, follow repository signed Conventional Commit and PR rules for implementation. External provisioning, real funds and deployment remain separate explicit actions with concrete reviewed configuration. Do not silently replace the full requested product with a homepage or mocked console.
