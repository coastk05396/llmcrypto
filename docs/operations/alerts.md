# Alert preparation

Status: **database signals and operator views exist; production collection/paging is blocked**. No production SLO baseline, dashboard, on-call routing, paging delivery test or measured alert latency exists. A row in `payment_alerts` is not a delivered notification.

## Existing signals

- `GET /healthz` is process liveness only. Error responses and `X-Request-Id` carry correlation IDs; unexpected API errors are logged as JSON by `apps/api/src/http.ts`. This is not a complete structured access-log/metrics/tracing pipeline; startup and beta-runner logs have other formats.
- Freshly elevated operators can read `/api/operator/reconciliation`, `/payment-alerts`, `/payment-reviews`, `/stuck-reservations` and `/ledger-mismatches` under that operator prefix. Customer roles and API-key console sessions do not grant operator access. See [reconciliation](reconciliation.md).
- `reconcilePayments` can write deduplicated `CHAIN_CLIENT_ERROR`, `MISSED_EVENT`, `EVENT_NOT_CANONICAL`, `LEDGER_MISMATCH`, `ORPHAN_LEDGER_CREDIT` and `LEDGER_UNBALANCED` alerts; chain reorg handling also records critical signals. Only fake-chain exercises exist. The deployed entrypoint schedules no chain/reconciliation loop.
- `findStuckReservations` reports `not_dispatched`, `dispatched_stale` and `usage_pending_past_deadline`; default age filter is `OPERATOR_STUCK_RESERVATION_SECONDS=3600`. Unresolved-usage deadline defaults to 86,400 seconds, an unconfirmed commercial policy, not an alert-delivery promise.
- Notification/export/retention functions exist but are not scheduled by the worker entrypoint. No real messaging credentials or automatic delivery is established by configuring an environment variable.

## Proposed response rules (must be implemented and rehearsed)

| Signal / proposed severity | Operator response | Missing production evidence |
| --- | --- | --- |
| Ledger mismatch, non-zero ledger, negative balance, duplicate credit/charge: critical on first finding | Stop financial side effects; compare request/reservation/usage/deposit evidence; preserve audit; dual approval for justified adjustments. | Scheduled checks, paging and containment drill. |
| Credited transfer becomes noncanonical / reorg: critical | Confirm event with approved chain adapter; inspect append-only reversal/review; never delete prior ledger postings. | Real adapter/finality policy and reorg exercise. |
| Stuck hold or pending usage past deadline: warning; escalate on financial impact | Inspect dispatch evidence; reconcile usage; do not retry possibly accepted upstream work or release holds blindly. | Reconcile scheduler, provider lookup and measured backlog/latency thresholds. |
| Chain RPC failure, missed event or lag: warning; escalate on settlement impact | Check RPC/head/cursor; pause settlement if canonical truth is uncertain; deduplicate recovered events. | Real chain, healthy head baseline, lag objective, paging. |
| API/provider errors, latency, resource exhaustion: warning/critical by approved SLO | Correlate redacted request IDs; hold rollout and use [rollback](rollback.md) for sustained regression. | Counters/histograms, representative p95/p99, load tests and SLO/burn-rate policy. |
| Backup stale beyond proposed 15-minute RPO, failed restore/checksum, worker heartbeat absent: critical | Stop rollout; restore confidence in verified recovery and scheduled work before resuming. | Backup schedule/age metric, restore verification and worker liveness instrumentation. |

Before production, assign a human primary/backup owner, implement collection and delivery, agree thresholds/windows and escalation time, then inject each fault in authorized staging and prove detection -> page -> acknowledgement -> recovery -> closure. Redact cookies, Authorization headers, keys, wallet signatures, imported source and prompt/completion bodies. The current error logger includes exception messages; sanitization must be reviewed before exporting logs. Resolve payment alerts only with an audited note; resolving an alert does not settle a payment or fix a ledger mismatch. Production paging remains blocked until this drill is recorded.
