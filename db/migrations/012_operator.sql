-- 012_operator: separate operator role, per-session elevation, and append-only dual-control adjustments.
-- Additive. Rollback: drop the four tables and functions (only while no adjustment has been applied; applied adjustments
-- are ordinary append-only ledger transactions and stay).
-- Operator status is NOT a membership role and is never derived from a wallet: a row here is created out-of-band
-- (configuration at startup or the operator CLI). No HTTP route inserts, updates or deletes operators.

create table operators (
  user_id     text primary key references users (id),
  granted_by  text not null check (granted_by in ('config', 'cli')),
  note        text,
  granted_at  timestamptz not null,
  revoked_at  timestamptz
);

-- Step-up per session: elevation is bound to ONE session row and expires; a new session needs a new elevation.
create table operator_elevations (
  session_id   text primary key references sessions (id),
  user_id      text not null references users (id),
  verified_at  timestamptz not null,
  expires_at   timestamptz not null
);

-- Proposals are immutable. The decision is a separate immutable row (one per proposal), so a proposal can be decided
-- exactly once and nothing is ever updated or deleted.
create table operator_adjustments (
  id                   text primary key,
  seq                  bigint generated always as identity,
  account_id           text references accounts (id),   -- null only for reject_review of an account-less payment review
  action               text not null check (action in ('credit', 'debit', 'reject_review')),
  amount_microusd      numeric(30, 0) not null check (amount_microusd >= 0),
  reason               text not null check (length(reason) between 10 and 1000),
  review_id            text references payment_reviews (id),
  proposed_by_user_id  text not null references users (id),
  created_at           timestamptz not null,
  expires_at           timestamptz not null,
  check ((action = 'reject_review') = (amount_microusd = 0)),
  check (action = 'reject_review' or account_id is not null),
  check (action <> 'reject_review' or review_id is not null)
);
create index operator_adjustments_account_idx on operator_adjustments (account_id, created_at, id);
create trigger operator_adjustments_immutable before update or delete on operator_adjustments for each row execute function forbid_mutation();

create table operator_adjustment_decisions (
  adjustment_id          text primary key references operator_adjustments (id),
  decision               text not null check (decision in ('approved', 'rejected')),
  decided_by_user_id     text not null references users (id),
  reason                 text check (reason is null or length(reason) <= 1000),
  ledger_transaction_id  text references ledger_transactions (id),
  created_at             timestamptz not null,
  check (decision = 'approved' or ledger_transaction_id is null)
);
create trigger operator_adjustment_decisions_immutable before update or delete on operator_adjustment_decisions for each row execute function forbid_mutation();

-- Defence in depth for dual control: the database itself refuses a decision by the proposer.
create function operator_decision_guard() returns trigger language plpgsql as $$
declare proposer text;
begin
  select proposed_by_user_id into proposer from operator_adjustments where id = new.adjustment_id;
  if proposer = new.decided_by_user_id then
    raise exception 'operator adjustment % cannot be decided by its proposer', new.adjustment_id;
  end if;
  return new;
end $$;
create trigger operator_adjustment_decisions_dual_control before insert on operator_adjustment_decisions
  for each row execute function operator_decision_guard();
