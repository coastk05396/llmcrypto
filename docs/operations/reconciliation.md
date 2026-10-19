# Operator workflows: reconciliation, dual-control adjustments, audit (task 24, backend)

Code: `apps/api/src/operator/{service,routes,cli}.ts`, `apps/api/src/auditlog.ts`, `packages/domain/src/{adjustment-policy,reconciliation}.ts`,
migration `db/migrations/012_operator.sql`. Tests: `tests/integration/operator.test.ts`, `packages/domain/src/design-adjustment.test.ts`.
Related: `docs/operations/payments.md` (how deposits, reviews and alerts are produced).

## Who is an operator

Operator is **not** a membership role and is never inferred from a wallet, an address, an account or a customer role. It is a row in `operators`
created **out of band**:

* configuration: `OPERATOR_USER_IDS` (comma-separated **user ids**, not addresses), synced at API start; removing an id revokes a *config* grant;
* CLI: `pnpm --filter @llmcrypto/api operator grant <userId> [note]` / `operator revoke <userId>` (`DATABASE_URL=pglite:<dir>`; with the current embedded
  database the server must not hold the same directory open).

There is **no HTTP route** that creates, edits or lists operators (tested: 404/405). Grants and revocations are audited without an account.
An operator signs in like any user (so they also have a normal customer account), but customer routes only ever return that user's own account.

## Stronger authentication: step-up on every session

Every `/api/operator/*` route except `/session` needs, in this order: a signed-in non-API-key session (401 otherwise), an active operator grant
(403 `FORBIDDEN`), and a **live elevation bound to this session** (403 `STEP_UP_REQUIRED`).

* `POST /api/operator/session` creates the elevation. It requires the session to have authenticated (sign-in or `POST /api/session/step-up`) within
  `OPERATOR_STEP_UP_WINDOW_SECONDS` (default **300**, stricter than the customer 900-second window). Renewing a session does not refresh it.
* The elevation lasts `OPERATOR_ELEVATION_SECONDS` (default **900**) and then lapses; it is keyed by session id, so a new session or a second device
  starts unelevated. `DELETE /api/operator/session` ends it; revoking the grant deletes it immediately.
* Not implemented: a second factor beyond the existing sign-in methods. "Stronger" here means freshness + per-session elevation + short lifetime.
  Mandatory hardware-key or TOTP operator sign-in is a product decision that is not made; it should be added before production operator use.

## Reconciliation views (read-only, all accounts)

| Route | Shows |
| --- | --- |
| `GET /reconciliation` | counts: open reviews, unresolved alerts, stuck reservations, ledger mismatches, pending adjustments |
| `GET /payment-reviews?status=open\|resolved` | the manual-review queue from `payment_reviews` (underpaid, overpaid, wrong network, duplicate, reorg reversal, unmatched) |
| `GET /payment-alerts?resolved=false\|true`, `POST /payment-alerts/{id}/resolve` | `payment_alerts` from the payment reconcile job; resolving records a note, moves no money |
| `GET /stuck-reservations` | active holds older than `OPERATOR_STUCK_RESERVATION_SECONDS` (default 3600) that never finished: `not_dispatched`, `dispatched_stale`, `usage_pending_past_deadline` |
| `GET /ledger-mismatches` | recomputed from the ledger on demand: unbalanced transaction, ledger sum not zero, settled reservation vs ledger spend, usage charge vs reservation, deposit credit vs ledger, orphan deposit credit, negative customer balance |

These read the same tables the payment reconcile job and gateway write; they do not trust a cached flag. Lists are capped at 200 (`truncated: true`).
Operators see ids and amounts across accounts and never prompt/completion text (none is stored).

## Adjustments: append-only, dual control

`POST /adjustments` (Idempotency-Key) **proposes** a `credit`, `debit` or `reject_review`. A proposal moves no money. A *different* operator then
`POST /adjustments/{id}/approve` (or `/reject`); on approval the ledger transaction (`kind=adjustment`, source = the adjustment id, balanced, keyed so it
can post at most once) is written **in the same database transaction** as the decision.

Rules, each tested:

* the proposer can never decide their own proposal (403); the database also refuses it (trigger), so a bug in the API cannot bypass it;
* one decision per proposal (primary key); concurrent approvals: exactly one wins, one ledger transaction (409 for the rest);
* proposals expire after `OPERATOR_ADJUSTMENT_TTL_SECONDS` (default 72 h) and cannot be decided afterwards;
* amount bounds: `> 0` and `<= OPERATOR_ADJUSTMENT_MAX_MICROUSD` (default 1 000 000 000 micro-USD = 1 000 USD, **an unconfirmed commercial policy**);
  `reject_review` carries no amount; a debit needs the account's *available* balance (posted minus holds) at approval time (409 `INSUFFICIENT_FUNDS`);
* operators cannot propose OR decide on an account they belong to (conflict of interest);
* a review credit cannot exceed the reviewed transfer's computed value (same conversion as the deposit path); a review with no transfer value can only be rejected;
* a rolling 24-hour ceiling (`OPERATOR_DAILY_LIMIT_MICROUSD`, default 5 000 USD) bounds the sum of approved credits and debits (429 + `Retry-After`; advisory across accounts: two simultaneous approvals on different accounts can overshoot by one amount);
* `operator_adjustments` and `operator_adjustment_decisions` reject UPDATE and DELETE; corrections are new adjustments.

Limit of dual control: two operator *users* are required. Two user rows controlled by one human cannot be detected; that is an organisational control.

## Resolving a payment review through the ledger

Link the proposal to the review with `reviewId`:

* **credit**: `accountId` must equal the review's account; on approval the credit posts and the review becomes `resolved` (`credited by adjustment <id>`);
* **reject**: `reject_review` (no ledger entry); on approval the review becomes `resolved` (`rejected by adjustment <id>`);
* a review with no account (an unmatched on-chain transfer) can only be rejected; crediting it would need an identification step that does not exist yet;
* one pending proposal per review; a resolved review cannot be proposed again.

The amount of a review credit is typed by the operator, bounded as above. There is no automatic conversion from the on-chain amount, and the linked deposit
intent is updated only when the reviewed event is still its primary event. Historical review credits preserve a later primary payment pointer. Event-backed credits are compensated once if their event is removed; a primary review credit is not also reversed as a separate historical adjustment.

## Customer audit view

`GET /api/audit?source=all|operator` (owner/admin/billing) lists the account's audit events newest first. Every operator step that concerns the account
(`operator.adjustment_proposed|approved|rejected`, `operator.alert_resolved`) appears with `actor: "operator"` and **no user id**; the operator's identity is
kept in the internal row only. Amounts, actions and ledger ids are visible; the operator's `reason` and `note` text is **withheld** from the customer view (it stays in the internal audit row).
Elevation and grant events carry no account and never appear in a customer view.

## Not done / not verified

* `Operations.tsx` and the customer audit view have browser coverage. Staging A10 recovery/rollback, alert paging/delivery and scheduled reconcile loops remain unavailable.
* Reconciling a *missing on-chain event* is the payment worker's `reconcilePayments` (against `FakeChainClient` only); the operator views surface its alerts.
* Operator access is only as strong as the sign-in methods in `docs/auth-methods.md`.
