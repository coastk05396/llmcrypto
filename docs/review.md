# Independent final fix re-review

**Local PR readiness: APPROVED.** The prior P1 long-URL userinfo disclosure is fixed in the reviewed working-tree source. No required correctness/security findings remain in this focused re-review. **Production: BLOCKED**, separately and unchanged by this local approval.

Reviewed on 2026-10-19 in `/home/rick/repo/llmcrypto`, HEAD `a036823426bcdc7533d5b89e2b978da43c0d35df`. Scope: independently re-read the frozen credential fix and regressions, validate newline/exact-boundary behavior and bounded evidence cost, rerun graph/repository tests, and compare prior review invariants. No repository edits, new agents, mutations, commits, pushes or external publishing were performed. This report is the only authored file. Coordinator reported concurrent EOF-only cleanup/staging; final hashes below identify the reviewed working tree, rather than claiming a review of an immutable commit or the eventual staged artifact.

## Prior P1 disposition

**Resolved:** `packages/domain/src/repository-graph.ts:47–54` slices at most 1,001 UTF-16 code units starting at the physical line. If that window contains no LF and exceeds 1,000 units, it returns the constant `[evidence omitted: source line exceeds 1000 characters]`. Otherwise the entire evidence line is available to redaction before the 200-character display truncation. Consequently a userinfo terminator beyond the old 1,000-character truncation cannot leave a username/password prefix in evidence.

Both JS/TS (`repository-graph.ts:119`) and Go (`:244`) use this helper, while separately applying `redactUrlCredentials` to the complete extracted specifier. `repository-policy.ts:110–115` still greedily redacts authority userinfo through its last @ before truncating snippets. Line numbers and sanitized specifiers remain available even when evidence is omitted. No helper signature, export shape, database schema or additional dependency changes are involved.

Rechecked persistence/export flow: `apps/worker/src/repository-import.ts:164` transfers sanitized refs into edges, `:216–220` persists them, and `apps/api/src/imports/routes.ts:274–278` exports persisted edges. The fix operates before all these consumers; it does not rely on response-only masking.

## Independent verification

Command run against current source:

```sh
./node_modules/.bin/vitest run packages/domain/src/repository-graph.test.ts tests/integration/repository.test.ts --maxWorkers=1
```

**Result: 2 files passed, 87 tests passed, 20.12 seconds.** This includes the new JS/Go long-userinfo unit cases, short and 50-segment password integration cases, existing scanner cost tests, and existing repository import/access/export tests.

The new integration at `tests/integration/repository.test.ts:71–92` uploads JS and Go source with short/long credentials, then checks whole-database dump, edge responses and export for username and distinctive password-prefix absence. The 50-segment input exceeds the evidence boundary but remains below this harness's 2,000-byte file cap. It also asserts an ordinary `safe-package` edge survives. Unit tests positively assert the sanitized long-URL specifier and omission marker, so the combined coverage establishes retained URL extraction rather than relying solely on negative persistence assertions.

Additional independent assertions executed without writing files, by transpiling the current policy and graph modules in memory using installed TypeScript:

- Both JS and Go, physical content lengths 999/1,000/1,001, EOF/LF/CRLF endings, with ordinary and credential-bearing imports: 36 cases.
- Both JS and Go, long userinfo whose terminating @ is beyond 1,000, EOF/LF/CRLF endings: 6 cases.
- All 42 cases passed: correct omission threshold, no username/password prefix, sanitized specifier retained, correct line 2 after an initial newline, and adjacent safe import on line 3 retained for LF/CRLF cases.
- A separate 1 MiB line probe for each parser returned the omission marker (JS 23 ms; Go 27 ms in this run). These are local synthetic observations, not representative workload benchmarks.

Exact-boundary interpretation: 1,000 units followed by LF is fully available and redacted; 1,001 units at EOF or before LF is omitted. The CR of CRLF counts toward the bounded raw line, so 1,000 content units plus CR is conservatively omitted, while 999 plus CR is retained with CR removed. This harmless evidence loss does not disclose credentials. The helper's line lookup and temporary string are capped at 1,001 units; redaction of evidence is consequently bounded at 1,000. Full-source lexing, line-index construction and full-specifier sanitization keep their existing costs; this finding does not establish a bound on every scanner operation or all regex inputs.

Read supplied `/tmp/llmcrypto-long-url-red.log` (one long integration failed, one short passed) and `/tmp/llmcrypto-long-url-green.log` (87 tests passed). These are coordinator-supplied historical evidence, separate from the independent rerun above. No mutation experiment was performed in the shared checkout because the task expressly requires read-only code review.

## Prior invariants and coverage boundary

Read the prior `/tmp/llmcrypto-independent-final-review.md`, compared source fingerprints, and re-read the relevant current paths. No further local blocker was identified:

- Historical adjustment compensation still excludes the primary intent ledger transaction (`packages/domain/src/deposits-store.ts:244–250`), preserving the separate primary reversal path and adjustment-identified once-only reversal. Observer and reconciler still recheck credited adjustment events (`apps/worker/src/chain-observer.ts:72`, `reconcile-payments.ts:101`).
- Approval still locks the deposit before review, checks proposer and decider membership, rejects already credited events, rejects removed events transactionally, and updates primary intent state only while that review owns its event pointer (`apps/api/src/operator/routes.ts:305–375`). The across-account daily ceiling remains advisory, as disclosed by its comment.
- Invalid observations still permit valid replacement, while rejected/reviewed event redelivery is suppressed (`packages/domain/src/chain-events.ts:144–151`, `deposits-store.ts:154–159`).
- Accepted design revision replay still precedes mutable admission (`apps/api/src/beta.ts:56–65`), with replay identity/current status preserved and transaction-time revision/active checks (`apps/api/src/design/routes.ts:210–232`).
- Session generation checks and method-active checks remain inside session issuance (`apps/api/src/auth/session.ts:56–63`). Deposit-store, design-route and session-source hashes match the prior report exactly. Operator/policy EOF cleanup was reported by the coordinator; the relevant security logic was re-read in this review.

The prior independent report recorded 188 passing tests across seven files. This re-review reran only the two focused files (87 tests); it does not claim a fresh rerun of all seven, PostgreSQL concurrency checks, lint, typecheck, build, hosted CI or browser acceptance. Coordinator reports of 974 tests/46 files before this final fix, final browser 21 passed/1 conditional skip, and disabled variant 1 passed are supplied chronology, not independent results from this worker. Broad pre-fix results cannot be described as a full-suite rerun after the final fix.

Submission hygiene checkpoint: working-tree `git diff --check` was clean; `git diff --cached --check` still reported seven blank-EOF warnings at the checkpoint. Coordinator was notified to re-stage its EOF cleanups before signing. These are whitespace-only submission housekeeping, not a remaining security/correctness blocker; approval applies to the reviewed working tree, with the coordinator owning final index/commit verification.

## Production boundary

**BLOCKED.** `apps/api/src/index.ts:19` still accepts only embedded PGlite, with embedded beta runners at `:35`. `docs/release-checklist.md` explicitly retains absent real provider/chain/custody adapters, shared PostgreSQL/worker hosting, production ingress/secrets/strong operator authentication, graceful drain, reconciliation/delivery, staging recovery/rollback objectives, production load/SLO/paging evidence and explicit production authorization. CI requires real PostgreSQL tests (`.github/workflows/ci.yml:37`) but source inspection and local green results do not prove hosted CI or deployed production correctness. Local PR approval does not authorize production deployment, paid resources or real funds.

## Final reviewed fingerprints

```text
ebf42deb0d453a6418ea332579acd1bc0866ac88f97257885047bb311f466f8e packages/domain/src/repository-graph.ts
4b410b5501b591dc9cd679698c0781102cf27d365b51a963143746bbeeefc2ff packages/domain/src/repository-graph.test.ts
874105bab852a4872e8e8e034a6210b6acae6cbb1cf44172ecd9695801d4474e tests/integration/repository.test.ts
a55e7de0592895b19775490c95c561dca225f15e3e23830986bdcb5c70b9b635 packages/domain/src/repository-policy.ts
a39736190b5de8e666fae73007c294fbd8586d48d68cb40026a9a72649965256 apps/api/src/operator/routes.ts
852726b80ae95f9e0437aefabd466af1efaeec674608a2e668b2e9953c5186fc packages/domain/src/deposits-store.ts
731b974cae72aabaea9b7cb331a8825b378e78a8ac626f4fad27a0c81823b338 apps/api/src/design/routes.ts
ba940a99b91caded95c157169054495be6bf540d2df59073a7552bc4626a9275 apps/api/src/auth/session.ts
```

## Coordinator submission verification

All eight reviewed source fingerprints were checked against the final working tree after review. EOF cleanups were re-staged and `git diff --cached --check` passed before signing. After the independent review, the final frozen-source unit/contract/integration suite passed 977 tests across 46 files with required genuine PostgreSQL startup and no skips. Final results and the signed PR artifact are recorded in the delivery checkpoint in `tasks/todo.md`; hosted CI is separate evidence.
