# Rollback preparation

Status: **runbook only; application rollback in staging/production not exercised**. The local [backup drill](backup.md) restored the same application's snapshot. It did not run an earlier artifact or reverse migrations. No production action is authorized.

## Triggers and containment

Stop release progression for any ledger mismatch, negative customer funds, duplicate credit/charge, cross-account data exposure, invalid authentication acceptance or possible secret exposure. Hold on new provider failures, stuck jobs/holds, missing usage or missing telemetry. Production error/latency baselines and numeric thresholds have not been measured or approved; absence of observations is not a healthy result.

The release owner must record incident time, candidate/previous artifact IDs, schema/checksum/config versions, affected request/deposit IDs and decision. Drain gateway admission and pause side effects at the host/proxy before changing application or data. There is no implemented universal admission/worker kill switch. Disabling beta route flags alone does not stop already queued repository/design work; the API embeds their runners. A future worker host needs explicit pause/drain controls.

## Recovery decision

| Case | Required action |
| --- | --- |
| Application regression, unchanged compatible schema | In an isolated authorized staging environment, boot the pinned previous artifact against a database copy first; verify reads/writes/settlement and configuration compatibility before switching traffic. |
| Additive migration | Keep schema/data unless previous-reader/writer compatibility has been demonstrated. Migration comments are preparation, not tested down migrations. |
| Incompatible migration / corrupt state | Prefer a reviewed forward fix; otherwise restore a verified pre-change snapshot into a new database, quantify lost writes and independently reconcile external effects before activation. |
| Secret compromise | Contain access and follow a reviewed rotation/session/key revocation procedure; old secret values must not simply be restored. That recovery procedure has not been tested here. |

Migration runner records SHA-256 and has no down command; do not alter applied files, delete `schema_migrations`, drop financial tables, bypass append-only triggers, or assume `git revert` reverses a database. No destructive migration command is supplied. Preserve original and recovered databases separately.

## Required authorized staging exercise

1. Select immutable current and previous versions, matching lockfiles/runtime and supported configuration; record a fresh verified backup and snapshot cut.
2. Rehearse admission stop, in-flight drain, runner pause and database clean close. Current API lacks shutdown handling, so this is blocked pending implementation.
3. Start the previous version against a restored copy only after schema compatibility review. Measure total recovery time including diagnosis, restore, application boot, checks and traffic switch; include snapshot age and post-cut write loss.
4. Verify health plus actual DB access, login/step-up, key revocation, scoped access, streaming/non-streaming fake requests, ledger/usage/balance equality, operator dual control, replay/deduplication and job status. With future real integrations, reconcile provider-accepted requests and canonical chain events before resuming side effects; restored database state cannot undo an external transfer or provider charge.
5. Confirm telemetry/paging, observe against the approved baseline, then authorize reopening. Retain evidence and owner sign-off. Previous-version compatibility, recovery traffic switch, production timings and external reconciliation remain **blocked / unverified**.
