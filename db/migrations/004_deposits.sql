-- 004_deposits: deposit intents, observed chain events, manual-review queue and reconciliation alerts.
-- Plain PostgreSQL (also runs on PGlite). Amounts on chain are atomic units (numeric(78,0) holds a uint256);
-- money in the ledger is whole micro-USD. Nothing here is a treasury or custody decision: receiving
-- addresses come from an AddressProvider and the supported (network, asset) pairs come from configuration.
-- Native assets are stored with asset_contract = '' (NULLs would defeat the unique event key).
-- Rollback (destroys payment evidence; never after a credit has posted): drop table payment_alerts, payment_reviews, chain_events, deposit_intents.
-- Ledger transactions that reference deposits (003) stay and become orphan credits that reconciliation will flag.

-- Correlation: every intent owns a UNIQUE receiving address (unique (network, address_key)); a transfer is
-- matched to an intent only by the destination address that the server itself generated for that intent.
create table deposit_intents (
  id                    text primary key,
  account_id            text not null references accounts (id),
  created_by_user_id    text not null references users (id),
  network               text not null,
  asset                 text not null,
  chain_id              text not null,
  asset_contract        text not null,
  decimals              integer not null check (decimals >= 0 and decimals <= 36),
  required_confirmations integer not null check (required_confirmations >= 1),
  address               text not null,
  address_key           text not null,           -- normalized (lower-cased hex addresses) for matching
  amount_atomic         numeric(78, 0) not null check (amount_atomic > 0),
  -- Policy snapshots: later configuration changes never alter an intent that already exists.
  microusd_per_token    numeric(30, 0) not null check (microusd_per_token > 0),
  overpayment_policy    text not null check (overpayment_policy in ('review', 'credit_full')),
  expires_at            timestamptz not null,
  accept_until          timestamptz not null,    -- expires_at + grace; transfers mined later need review
  status                text not null check (status in ('CREATED', 'DETECTED', 'CONFIRMING', 'CREDITED', 'EXPIRED', 'REVIEW_REQUIRED', 'REVERSED')),
  confirmations         integer not null default 0 check (confirmations >= 0),
  matched_event_key     text,                    -- chain_events.event_key of the transfer this intent is tied to
  review_reason         text,
  credited_microusd     numeric(30, 0),
  ledger_transaction_id text references ledger_transactions (id),
  reversal_transaction_id text references ledger_transactions (id),
  created_at            timestamptz not null,
  updated_at            timestamptz not null,
  unique (network, address_key),
  check (status <> 'CREDITED' or (ledger_transaction_id is not null and credited_microusd is not null)),
  check (status <> 'REVIEW_REQUIRED' or review_reason is not null),
  check (status <> 'REVERSED' or reversal_transaction_id is not null)
);
create index deposit_intents_account_idx on deposit_intents (account_id, created_at, id);
create index deposit_intents_open_idx on deposit_intents (status, accept_until) where status in ('CREATED', 'DETECTED', 'CONFIRMING', 'EXPIRED');

-- Observed on-chain transfers. Identity is (network, tx hash, event index, asset contract): one transaction
-- may carry several transfers. Rows are updated as confirmations grow or the transfer leaves the canonical
-- chain (removed); history of credits/reversals lives in the append-only ledger and audit log.
create table chain_events (
  id                text primary key,
  event_key         text not null unique,
  network           text not null,
  chain_id          text not null,
  tx_hash           text not null,
  event_index       integer not null check (event_index >= 0),
  asset_contract    text not null,
  from_address      text,
  to_address        text not null,
  to_address_key    text not null,
  amount_atomic     numeric(78, 0) not null check (amount_atomic >= 0),
  block_number      numeric(30, 0) not null,
  block_hash        text not null,
  block_time        timestamptz not null,
  confirmations     integer not null check (confirmations >= 0),
  removed           boolean not null default false,
  last_head_block   numeric(30, 0) not null,   -- chain head of the newest applied observation; older deliveries are ignored
  deposit_id        text references deposit_intents (id),
  match_result      text not null default 'unprocessed',
  first_seen_at     timestamptz not null,
  last_seen_at      timestamptz not null,
  unique (network, tx_hash, event_index, asset_contract)
);
create index chain_events_deposit_idx on chain_events (deposit_id) where deposit_id is not null;
create index chain_events_to_idx on chain_events (to_address_key);

-- Manual-review queue. Nothing in here is ever auto-credited or auto-spent. Resolution (operator action with
-- dual control) is task 24; until then rows stay open and are visible to reconciliation alerts.
create table payment_reviews (
  id             text primary key,
  kind           text not null check (kind in ('deposit', 'unmatched_event', 'duplicate_event', 'reorg_reversal')),
  reason         text not null,
  account_id     text references accounts (id),   -- null for transfers that match no intent
  deposit_id     text references deposit_intents (id),
  chain_event_id text references chain_events (id),
  status         text not null default 'open' check (status in ('open', 'resolved')),
  details        jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null,
  resolved_at    timestamptz,
  resolution     text,
  check ((status = 'open') = (resolved_at is null))
);
-- One open review per (kind, reason, event/deposit): redelivery never queues duplicates.
create unique index payment_reviews_open_uq
  on payment_reviews (kind, reason, coalesce(chain_event_id, ''), coalesce(deposit_id, '')) where status = 'open';
create index payment_reviews_account_idx on payment_reviews (account_id, created_at) where account_id is not null;

-- Reconciliation alerts (rows an operator/monitoring job reads). dedupe_key makes repeated detection idempotent.
create table payment_alerts (
  id           text primary key,
  dedupe_key   text not null unique,
  kind         text not null,
  severity     text not null check (severity in ('info', 'warning', 'critical')),
  account_id   text references accounts (id),
  deposit_id   text references deposit_intents (id),
  details      jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null,
  resolved_at  timestamptz
);
create index payment_alerts_open_idx on payment_alerts (created_at) where resolved_at is null;
