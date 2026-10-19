# Backup and restore preparation

Status: **isolated local clean-close drill passed; staging/production restore blocked**. SPEC proposes RPO <=15 minutes and RTO <=4 hours; these are unapproved production objectives, not achieved service guarantees. There is no scheduled backup, PITR, remote backup store or retention policy wired into the application.

## Safe local procedure

Use only a disposable persistent PGlite directory; do not delete or overwrite repository/runtime data. Do not open an API, worker or CLI against the same embedded directory concurrently.

1. Stop admission and await all writes/jobs, then call the owning `Db.close()` (`openPglite` in `apps/api/src/db.ts`). Current API startup has no graceful drain/close handler; killing it does not establish this prerequisite. The measured drill used an in-process host that explicitly awaited close. For an existing running API, clean-close backup remains blocked until an owner can establish quiescence and clean closure.
2. Record snapshot cut time, application revision, Node/PGlite versions and every `schema_migrations` name/checksum. Preserve secret versions separately under restricted access. Do not print secrets or include them in the database manifest.
3. Copy the **entire closed directory** to a new empty restricted directory. Generate a relative-path SHA-256 manifest and compare every copied file. A live filesystem copy, or copying only selected SQL tables, is not this procedure.
4. Restore that snapshot into a **different new directory**, verify its file hashes before opening, then open only the restored copy. Run `migrate` against the matching release: existing names must have matching checksums and should all skip. A mismatched checksum is a hard stop, not permission to edit history.
5. Compare all public table contents against the snapshot, including financial rows, audit, identity, key, idempotency, job and schema metadata. Run `verifyLedger`, `accountBalance`, `findLedgerMismatches` from `packages/domain`: all entries sum to zero, no unbalanced transactions, expected posted/held/available funds, zero unexplained mismatches.
6. With the matching runtime secrets, verify session/key behavior, liveness and one funded fake request through `createApp`. Confirm restored idempotency records and review pending jobs/holds before resuming any runner. Never replay potentially accepted provider work blindly.
7. Record elapsed copy and restore/verification time, snapshot age and deliberately omitted post-cut writes. Retain the source unchanged for comparison. Staging recovery additionally needs independently stored encrypted backups, access tests, retention/deletion policy, restore ownership and measured recovery under representative data/load.

The measured snapshot below predates later security migrations. It proves recovery of that 13-migration snapshot only; it does not verify the final candidate schema or previous-version rollback.

## Measured local drill

Run time: **2026-10-18 17:46 UTC** (2026-10-19 Asia/Taipei). Environment: Node **26.0.0**, PGlite **0.5.10**, one process, same local filesystem. No provider/chain/network requests or funds. Runtime-generated session/key/replay secrets and the disposable wallet key stayed in memory and were never printed or saved.

| Measurement | Observed |
| --- | --- |
| Migration state | 13 migrations (001–013); restored replay applied 0, skipped all 13 |
| Snapshot | 50 public tables; 1,252 files; 43,016,332 bytes |
| Clean close + copy + SHA-256 comparison | 4,145 ms |
| Copy restore + SHA-256 + DB/migration/content/integrity/HTTP verification | 4,245 ms |
| Synthetic activity | One wallet account, dev credit 10,000,000 micro-USD, one key and one fake completion before snapshot |
| Recovered funds | Posted 9,999,982 micro-USD; held 0; balanced ledger; zero reconciliation mismatches |
| Snapshot boundary | Later 7 micro-USD credit on source excluded from restored state |
| Continued operation | Existing session and API key accepted; new fake completion settled; still zero mismatches |

Every public table's sorted JSON rows matched before restored HTTP calls. The original directory was retained; no repository runtime directory was touched. There was no crash injection or previous-version application rollback. Synthetic dataset size, in-process `app.request` calls and a same-host copy do not establish end-to-end downtime, production RPO/RTO, remote disaster recovery, encryption, retention, PostgreSQL concurrency or chain/provider reconciliation after restore. A real snapshot schedule and measured snapshot age are still absent; observing no loss before this cut does not prove RPO <=15 minutes.

Temporary run evidence: `/tmp/llmcrypto-release-drill-WymtBW/result.json`; reproducible-in-this-workspace driver: `/tmp/llmcrypto-release-drills/restore.mts` (run from the root with `NODE_ENV=test ./node_modules/.bin/tsx /tmp/llmcrypto-release-drills/restore.mts`). These `/tmp` artifacts are ephemeral, not a shipped backup tool; this table is the durable result. Secrets were not retained, so retained drill databases cannot later demonstrate authentication without a new drill. Production/staging restore acceptance remains blocked until a reviewed durable tool and authorized environment exist.
