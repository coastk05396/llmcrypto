# Payments operations: deposit intents, chain observation, reconciliation

Status (2026-10-18): backend pipeline implemented and tested against a **fake chain**. No real network, token, RPC
provider, treasury or custody is configured or assumed. Nothing here has moved real funds.

## Flow

1. `POST /api/deposits` (owner or billing role, `Idempotency-Key` mandatory) creates a `deposit_intents` row for a
   configured (network, asset) pair with a unique receiving address from the `AddressProvider`.
2. The chain observer (`apps/worker/src/chain-observer.ts`) asks a `ChainClient` for transfers to the watched
   addresses and ingests each one atomically (`packages/domain/src/deposits-store.ts`): upsert `chain_events`, lock the
   intent, run the pure state machine (`packages/domain/src/chain-events.ts`), post the ledger credit.
3. The reconciler (`apps/worker/src/reconcile-payments.ts`) re-derives facts from chain and ledger independently and
   writes `payment_alerts`.

A client never submits a transaction hash; there is no endpoint that accepts one (unknown request fields are rejected
with 422). Chain facts come only from a `ChainClient`.

## Correlation (how a transfer is tied to an intent)

Each intent gets its **own receiving address** (`unique (network, address_key)`). A transfer is matched to the intent that
owns its destination address, preferring the intent on the same network. EVM hex addresses compare case-insensitively;
other formats (for example TRON base58) compare exactly. A unique amount suffix on a shared address was rejected: it breaks
on rounding, wallet fee deduction and exchange withdrawals.

`AddressProvider` (`apps/api/src/payments/address-provider.ts`) is the custody boundary. Contract: unique per intent,
deterministic per intent, no wallet keys in the frontend or the application database. Only `TestAddressProvider` exists
(`PAYMENT_ADDRESS_SOURCE=test`): it hashes the intent id into a valid-looking address nobody holds a key for, and refuses
to run when `NODE_ENV=production`. Any real funds sent to such an address are lost.

## States

`CREATED -> DETECTED -> CONFIRMING -> CREDITED`, plus `EXPIRED`, `REVIEW_REQUIRED`, `REVERSED`.

| State | Meaning | Leaves via |
| --- | --- | --- |
| CREATED | Waiting for a transfer. Stays CREATED until expiry + grace passes (the API reports `expiresAt`; the grace covers observer lag). | transfer seen; sweep to EXPIRED |
| DETECTED | A matching transfer is known but unmined (0 confirmations). | confirmations; removal reverts to CREATED/EXPIRED |
| CONFIRMING | Mined, fewer confirmations than required. | finality -> CREDITED; removal reverts |
| CREDITED | Finalized and matched; one balanced ledger transaction (`kind=deposit`, `source=deposit/<intent id>`). | reorg removal -> REVERSED |
| EXPIRED | No transfer by `expires_at + grace`. A transfer **mined before the deadline** but observed later is still honoured; one mined after is `LATE_PAYMENT` review. | transfer -> normal path or REVIEW_REQUIRED |
| REVIEW_REQUIRED | Funds seen but not auto-creditable. Never auto-resolved, never auto-spent. Reason in `reviewReason`. | operator workflow (task 24, not built) |
| REVERSED | A credited transfer left the canonical chain. A compensating `kind=reversal` ledger transaction restored the balance; the original credit is kept (ledger is append-only). | terminal |

Review reasons: `UNDERPAID`, `OVERPAID` (when policy is `review`), `WRONG_NETWORK`, `WRONG_CHAIN`, `WRONG_ASSET`,
`WRONG_DESTINATION`, `LATE_PAYMENT`, `DUPLICATE_PAYMENT`, `ZERO_CREDIT`, `REAPPEARED_AFTER_REVERSAL`. A transfer that
matches no intent is stored with `match_result=unmatched` and a `payment_reviews` row (`kind=unmatched_event`, no account).

Checks before credit: network, chain id, token contract (or native), destination, amount in atomic units, acceptance
deadline by **block time**, and confirmations >= the intent's snapshot. All thresholds are snapshotted on the intent when it
is created; later configuration changes do not alter existing intents.

Event identity is `(network, tx hash, event index, asset contract)`; two transfers in one transaction are two events.
Credited micro-USD = `floor(amountAtomic * microusdPerToken / 10^decimals)` (rounds down; never over-credits).

Duplicate/out-of-order handling: re-delivery is a no-op; observations carry the chain head height and any delivery older
than the stored head is ignored (including stale "removed" or stale lower confirmations); confirmations never decrease for
one transfer; the ledger anchors a credit on `(source_type, source_id, kind)` so a second credit cannot post.

Reorg: before credit the intent reverts (CREATED, or EXPIRED if past its deadline). After credit: `kind=reversal`
transaction (customer funds debited, funding source credited; the balance may go negative if the funds were already spent),
`payment_reviews` row `kind=reorg_reversal` with the account id (this is the **account review flag**; there is no separate
column), a `CREDITED_TRANSFER_REVERSED` critical alert and audit event. If the transfer reappears it is queued as
`REAPPEARED_AFTER_REVERSAL`; it is never credited again automatically.

## Configuration

| Key | Meaning |
| --- | --- |
| `PAYMENT_NETWORKS_CONFIG` | JSON `{"routes":[...]}`. Empty/unset = no networks: `POST /api/deposits` returns **503 UNAVAILABLE "No payment networks configured"** and `GET /api/deposits/networks` returns `{"items":[]}`. Invalid JSON/fields fail at startup. |
| `PAYMENT_ADDRESS_SOURCE` | `none` (default; deposits unavailable) or `test` (TEST ONLY provider). No real provider exists. |
| `PAYMENT_MAX_OPEN_INTENTS` | Open (CREATED) intents per account, default 10 (422 beyond). |

Route fields (all required unless noted; there are no defaults for business policy): `network`, `asset`, `chainId`,
`assetContract` (string or `null` for native), `decimals`, `confirmations`, `expirySeconds` (60 s to 30 d), `graceSeconds`,
`microusdPerToken` (micro-USD per whole token; a business decision, for example `"1000000"` for a 1:1 stablecoin only if
approved), `overpayment` (`review` | `credit_full`), optional `minAmountAtomic` (default 1), `maxAmountAtomic`
(default none). Underpayment is always `REVIEW_REQUIRED`; there is no tolerance setting.
Not read by the application: `CHAIN_RPC_URL_EVM`, `CHAIN_RPC_URL_TRON` (placeholders in `.env.example` for the future adapters).

## API surface (contract draft-0.3 plus this slice)

`POST /api/deposits`, `GET /api/deposits`, `GET /api/deposits/networks`, `GET /api/deposits/{id}`; owner and billing roles
only; other accounts' ids are 404. New `Deposit` fields: `asset`, `decimals`, `requiredConfirmations`, `createdAt`,
`reviewReason`. `CreateDepositRequest` is strict.

## Tables (`db/migrations/004_deposits.sql`)

`deposit_intents`, `chain_events` (unique event key and unique `(network, tx_hash, event_index, asset_contract)`),
`payment_reviews` (manual-review queue; one open row per kind/reason/event), `payment_alerts` (deduplicated).
Rollback: the migration only adds tables; `drop table payment_alerts, payment_reviews, chain_events, deposit_intents;`
is safe only while no deposit ledger transactions exist (ledger rows reference intent ids by text and are append-only).

## Reconciliation alerts (`payment_alerts`)

`MISSED_EVENT`, `EVENT_NOT_CANONICAL`, `LEDGER_MISMATCH`, `ORPHAN_LEDGER_CREDIT`, `LEDGER_UNBALANCED`,
`CHAIN_CLIENT_ERROR`, `CREDITED_TRANSFER_REVERSED` (written at reversal time). Alerts are rows only; paging/monitoring is
release work (task 26). Both jobs are plain functions; **no scheduler runs them** because the only DB driver is embedded
PGlite, which a separate worker process cannot share with the API.

## BLOCKED / not built

- **Treasury, custody and address derivation**: BLOCKED pending a decision (HD derivation with an offline/HSM key, per-intent
  deposit contracts, or an exchange/custodian sub-account API). The `AddressProvider` interface is the seam. Wallet keys must
  never reach the frontend or the application database.
- **Real chain adapters**: BLOCKED (no provider/network decision). `ChainClient` has only `FakeChainClient`. A real adapter
  must compute confirmations, report reorgs via `getTransfer` returning null, and report the head height for ordering.
- **Approved parameters**: supported (network, asset) pairs, token contracts, chain ids, decimals, **confirmation counts**
  (per chain finality), expiry/grace, overpayment policy, min/max and the micro-USD rate are unapproved business/ops
  decisions. The test fixtures use synthetic values and are not recommendations.
- **Operator resolution** of `payment_reviews` and any manual adjustment (needs dual control and audit; task 24). No
  operator endpoints or adjustment table exist. Treasury refunds of unmatched/over/underpayments: not allowed until a
  reviewed policy exists.
- **Sandbox/testnet transfer** (todo task 14 verify step): not run; needs authorization, a chosen network and an adapter.
- Production monitoring of alerts, backup and rollback procedures (task 26).
