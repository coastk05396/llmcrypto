-- 003_ledger: immutable price versions, balanced double-entry ledger, gateway requests, usage records
-- and reservations (holds). Plain PostgreSQL (also runs on PGlite). Money is whole micro-USD in numeric(30,0);
-- the application only ever handles it as bigint/decimal strings.
-- Rollback (destroys the financial record; never in production): drop table reservations, usage_records, request_transitions, requests, ledger_entries,
-- ledger_transactions, price_rates, price_versions; drop the functions forbid_mutation(), ledger_entry_balanced(), ledger_transaction_has_entries(),
-- usage_records_guard(); drop column projects.spend_cap_microusd. Production rollback is a forward migration, not a drop: ledger rows are append-only.

-- Projects may carry a lifetime spend cap that reservations enforce next to the per-key cap.
alter table projects add column spend_cap_microusd numeric(30, 0)
  check (spend_cap_microusd is null or spend_cap_microusd > 0);

create function forbid_mutation() returns trigger language plpgsql as $$
begin
  raise exception '% is append-only (% rejected)', tg_table_name, tg_op;
end $$;

-- Price versions are immutable snapshots. A price change registers a NEW version; old ones never change.
create table price_versions (
  id            text primary key,
  source        text not null,
  effective_at  timestamptz not null,
  created_at    timestamptz not null
);
create table price_rates (
  price_version_id                text not null references price_versions (id),
  model_id                        text not null,
  input_microusd_per_mtok         numeric(30, 0) not null check (input_microusd_per_mtok >= 0),
  cached_input_microusd_per_mtok  numeric(30, 0) check (cached_input_microusd_per_mtok is null or cached_input_microusd_per_mtok >= 0),
  output_microusd_per_mtok        numeric(30, 0) not null check (output_microusd_per_mtok >= 0),
  primary key (price_version_id, model_id)
);
create trigger price_versions_immutable before update or delete on price_versions for each row execute function forbid_mutation();
create trigger price_rates_immutable before update or delete on price_rates for each row execute function forbid_mutation();

-- Ledger: one transaction per financial event; its entries sum to zero (enforced at commit).
-- ledger_account: customer_funds (per customer account; credit positive), funding_source (where credits come
-- from: dev/test seed now, confirmed deposits later) and revenue (what customers spent).
create table ledger_transactions (
  id                text primary key,
  account_id        text not null references accounts (id),
  kind              text not null check (kind in ('deposit', 'spend', 'adjustment', 'reversal')),
  source_type       text not null check (source_type in ('request', 'deposit', 'adjustment')),
  source_id         text not null,
  price_version_id  text references price_versions (id),
  reason            text not null,
  created_at        timestamptz not null,
  -- A financial event posts at most once per kind: this is the idempotency anchor of settlement.
  unique (source_type, source_id, kind)
);
create table ledger_entries (
  id              text primary key,
  transaction_id  text not null references ledger_transactions (id),
  ledger_account  text not null check (ledger_account in ('customer_funds', 'funding_source', 'revenue')),
  account_id      text references accounts (id),
  amount          numeric(30, 0) not null check (amount <> 0),
  created_at      timestamptz not null,
  check ((ledger_account = 'customer_funds') = (account_id is not null))
);
create index ledger_entries_tx_idx on ledger_entries (transaction_id);
create index ledger_entries_funds_idx on ledger_entries (account_id, created_at, id) where ledger_account = 'customer_funds';
create trigger ledger_transactions_immutable before update or delete on ledger_transactions for each row execute function forbid_mutation();
create trigger ledger_entries_immutable before update or delete on ledger_entries for each row execute function forbid_mutation();

create function ledger_entry_balanced() returns trigger language plpgsql as $$
declare total numeric;
begin
  select coalesce(sum(amount), 0) into total from ledger_entries where transaction_id = new.transaction_id;
  if total <> 0 then
    raise exception 'ledger transaction % is unbalanced (sum %)', new.transaction_id, total;
  end if;
  return null;
end $$;
create constraint trigger ledger_entries_balanced after insert on ledger_entries
  deferrable initially deferred for each row execute function ledger_entry_balanced();

create function ledger_transaction_has_entries() returns trigger language plpgsql as $$
begin
  if (select count(*) from ledger_entries where transaction_id = new.id) < 2 then
    raise exception 'ledger transaction % needs at least two entries', new.id;
  end if;
  return null;
end $$;
create constraint trigger ledger_transactions_have_entries after insert on ledger_transactions
  deferrable initially deferred for each row execute function ledger_transaction_has_entries();

-- Gateway requests. Metadata only: no prompt or completion bodies are ever stored.
create table requests (
  id                  text primary key,
  account_id          text not null references accounts (id),
  key_id              text references api_keys (id),
  project_id          text references projects (id),
  run_id              text,
  parent_id           text,
  correlation_id      text,
  protocol            text not null check (protocol in ('openai_chat', 'anthropic_messages')),
  model               text not null,
  stream              boolean not null,
  state               text not null check (state in ('VALIDATED', 'RESERVED', 'DISPATCHED', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'USAGE_PENDING', 'SETTLED')),
  -- Why the request ended: succeeded | failed | cancelled | usage_unresolved | rejected (no charge)
  outcome             text,
  failure_code        text,
  price_version_id    text not null references price_versions (id),
  reserved_microusd   numeric(30, 0) not null,
  provider_request_id text,
  usage_deadline      timestamptz,
  created_at          timestamptz not null,
  updated_at          timestamptz not null,
  dispatched_at       timestamptz,
  finished_at         timestamptz
);
create index requests_account_idx on requests (account_id, created_at, id);
create index requests_key_idx on requests (key_id);
create index requests_pending_idx on requests (usage_deadline) where state = 'USAGE_PENDING';

create table request_transitions (
  id          bigint generated always as identity primary key,
  request_id  text not null references requests (id),
  from_state  text,
  to_state    text not null,
  at          timestamptz not null,
  note        text
);
create index request_transitions_request_idx on request_transitions (request_id, id);

-- One row per request. Token categories never overlap: input_tokens excludes cached_input_tokens.
-- Rates are copied here (rate snapshot) so a later price change cannot alter what was charged.
create table usage_records (
  id                        text primary key,
  request_id                text not null unique references requests (id),
  price_version_id          text not null references price_versions (id),
  input_rate_microusd       numeric(30, 0) not null,
  cached_input_rate_microusd numeric(30, 0) not null,   -- effective rate (input rate when the model has no cached rate)
  output_rate_microusd      numeric(30, 0) not null,
  input_tokens              numeric(30, 0) not null default 0,
  cached_input_tokens       numeric(30, 0) not null default 0,
  output_tokens             numeric(30, 0) not null default 0,
  usage_source              text not null default 'none' check (usage_source in ('none', 'provider')),
  computed_charge_microusd  numeric(30, 0) not null default 0,   -- exact cost rounded up once, before clamping to the hold
  charge_microusd           numeric(30, 0) not null default 0,   -- what was posted to the ledger
  absorbed_microusd         numeric(30, 0) not null default 0,   -- computed - charged when usage exceeded the hold
  ledger_transaction_id     text references ledger_transactions (id),
  created_at                timestamptz not null,
  settled_at                timestamptz
);
create function usage_records_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'usage_records cannot be deleted'; end if;
  if old.settled_at is not null then raise exception 'usage record % is settled and immutable', old.id; end if;
  if new.price_version_id <> old.price_version_id or new.input_rate_microusd <> old.input_rate_microusd
     or new.cached_input_rate_microusd <> old.cached_input_rate_microusd or new.output_rate_microusd <> old.output_rate_microusd then
    raise exception 'usage record rate snapshot is immutable';
  end if;
  return new;
end $$;
create trigger usage_records_guard before update or delete on usage_records for each row execute function usage_records_guard();

create table reservations (
  id                     text primary key,
  account_id             text not null references accounts (id),
  request_id             text not null unique references requests (id),
  key_id                 text references api_keys (id),
  project_id             text references projects (id),
  amount                 numeric(30, 0) not null check (amount >= 0),
  status                 text not null check (status in ('active', 'settled', 'released')),
  charge_microusd        numeric(30, 0),
  price_version_id       text not null references price_versions (id),
  ledger_transaction_id  text references ledger_transactions (id),
  created_at             timestamptz not null,
  closed_at              timestamptz,
  check ((status = 'active') = (closed_at is null))
);
create index reservations_account_active_idx on reservations (account_id) where status = 'active';
create index reservations_key_idx on reservations (key_id) where key_id is not null;
create index reservations_project_idx on reservations (project_id) where project_id is not null;
