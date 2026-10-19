# Release checklist

Decision: **NOT READY for production**. Local implementation/test/review and a ship PR are authorized at the product level; production, paid resources, real provider accounts, custody and real funds are not. This checklist records preparation and known limits, not full A1–A10 acceptance. Owners must attach exact candidate revision, command/date/result and evidence before checking any gate.

## Preparation evidenced here

- [x] Local setup, actual entrypoints, environment handling, PGlite limits and build outputs inspected and documented in [README](../README.md) and [deployment](operations/deployment.md).
- [x] [Backup](operations/backup.md), [rollback](operations/rollback.md), [alerts](operations/alerts.md) and existing [operator reconciliation](operations/reconciliation.md) linked.
- [x] Isolated persistent PGlite clean-close copy/restore: 13 migrations, 50 tables, per-file hashes/content/ledger/session/key checks; backup 4.145 s, restore+verification 4.245 s. Same-host synthetic exercise only; no production objective passed.

Documentation validation (2026-10-19 Asia/Taipei): all 24 relative links and Markdown fences checked; README secret generator creates distinct random values with mode 0600 and refuses overwrite; actual API entrypoint smoke passed `/healthz`, `/v1/models` and default-off `/api/features` on an isolated in-memory database. The restore and smoke drivers used installed tsx directly; this shell had no usable pnpm command (Corepack resolved to a Windows CRLF shim), so no full-suite result is asserted and no tool configuration was changed.

## Candidate verification

Current local results and acceptance limits: [acceptance](acceptance.md), [tracker](../tasks/todo.md), [independent review](review.md), [performance](performance.md) and [dependency audit](dependency-audit.md). Checkboxes below distinguish local verification from production acceptance.

- [x] Locked installation with `--ignore-scripts` passed on Node 26.0.0 / pnpm 10.18.3; supported Node range is `^22.12.0 || >=24.0.0`. Approved PostgreSQL test-binary postinstall was separately rebuilt.
- [x] Local lint/typecheck/build, full unit/contract/integration suite and browser verification passed with chronology and conditional skips disclosed in the tracker; the final credential fix has focused regression verification. Hosted CI remains separate evidence.
- [x] Independent focused code/security review approved local PR readiness after fixing its credential disclosure finding; scope, fingerprints and test evidence are in [review](review.md). This is not production approval.
- [ ] A1–A10 map to actual evidence; complete enabled Repository/Design/operator flows, browser states/accessibility, imports, exports and queued jobs verified. Feature-off responses or mocked success do not complete acceptance.
- [x] Dependency and recognizable-secret scan results, browser captures and bounded local performance measurements attached; production/representative load remains unverified.
- [ ] Review exact changed files and signed release/PR candidate through coordinator-owned shipping workflow. This documentation worker neither commits nor pushes.

## Production blockers — all unchecked

- [ ] Implement and validate real provider integrations, approved model catalog/pricing and provider-usage reconciliation; current provider is fake only.
- [ ] Approve custody/receiving addresses, real chain adapters and network/asset/finality/payment policy; verify separately authorized sandbox flows before any funded operation. Current chain/address fixtures are unusable for real funds.
- [ ] Add networked PostgreSQL/shared worker hosting and demonstrate real multi-connection locking, spend races, duplicate handling and job ownership; PGlite transaction serialization is insufficient evidence. The separate genuine-PostgreSQL regression suite covers bounded local lock/race scenarios, not a deployed application pool.
- [ ] Package/pin deployable server/worker artifacts and configure authorized staging, TLS/proxy, secure cookies, trusted ingress, secrets, operator stronger authentication, readiness and graceful drain/close.
- [ ] Schedule and verify chain/usage reconciliation, exports, notification delivery and retention. Starting the current worker is not evidence these run.
- [ ] Approve financial/operational retention and commercial policy, including unresolved usage, adjustments, limits and payment conversion; confirm recovery access to matching secret versions.
- [ ] Meet declared recovery objectives in authorized staging with representative data, independently stored encrypted backups and snapshot-age measurement. SPEC proposes RPO <=15 min / RTO <=4 h; production compliance is **blocked**, not passed by the local drill.
- [ ] Execute previous-version rollback and schema compatibility exercise, traffic switch and post-restore external reconciliation; current same-version restore does not establish rollback.
- [ ] Establish production baseline/load measurements, SLOs and on-call ownership; demonstrate fault injection, alert delivery/acknowledgement and recovery. No production measurements or paging evidence exists.
- [ ] Obtain explicit production authorization for the reviewed artifact/configuration and any separate spending/real-funds action. No deployment is implied by approving or merging a PR.
