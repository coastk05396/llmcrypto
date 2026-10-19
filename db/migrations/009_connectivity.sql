-- 009_connectivity: Telegram / WhatsApp pairing, per-binding event preferences, the notification outbox and
-- delivery records. Additive. Rollback: drop the four tables. Real delivery needs channel credentials that do
-- not exist yet; only Fake channel providers are implemented (see docs/integrations.md).

-- Single-use pairing codes. Only a keyed digest is stored. The code is claimed by the first channel user who sends
-- it to the bot/number (claimed_destination), then consumed exactly once by the issuing user's confirm call.
create table notification_pairings (
  id                    text primary key,
  account_id            text not null references accounts (id),
  user_id               text not null references users (id),
  channel               text not null check (channel in ('telegram', 'whatsapp')),
  code_hash             text not null unique,
  attempts              integer not null default 0,
  claimed_destination   text,
  claimed_at            timestamptz,
  consumed_at           timestamptz,
  created_at            timestamptz not null,
  expires_at            timestamptz not null
);
create index notification_pairings_account_idx on notification_pairings (account_id, created_at);

create table notification_bindings (
  id                    text primary key,
  account_id            text not null references accounts (id),
  paired_by_user_id     text not null references users (id),
  channel               text not null check (channel in ('telegram', 'whatsapp')),
  destination           text not null,                         -- channel user id / phone digits; shown masked
  events                jsonb not null default '[]'::jsonb check (jsonb_typeof(events) = 'array'),
  created_at            timestamptz not null,
  unpaired_at           timestamptz,
  unpaired_by_user_id   text references users (id)
);
create unique index notification_bindings_active_uq on notification_bindings (account_id, channel, destination) where unpaired_at is null;
create index notification_bindings_account_idx on notification_bindings (account_id, created_at, id);

-- Outbox: producers insert in the same transaction as the thing that happened; the worker claims with a lease.
-- data carries only an opaque reference id, never keys, prompts or amounts.
create table notification_events (
  id            text primary key,
  account_id    text not null references accounts (id),
  kind          text not null check (kind in ('insufficient_funds', 'key_cap_reached', 'loop_guard', 'deposit_credited', 'deposit_needs_review', 'test')),
  binding_id    text references notification_bindings (id),   -- set for a test message aimed at one binding
  data          jsonb not null default '{}'::jsonb,
  dedupe_key    text not null,
  status        text not null check (status in ('queued', 'running', 'done')),
  available_at  timestamptz not null,
  lease_until   timestamptz,
  created_at    timestamptz not null,
  processed_at  timestamptz,
  unique (account_id, dedupe_key)
);
create index notification_events_queue_idx on notification_events (available_at, id) where status in ('queued', 'running');

create table notification_deliveries (
  id                    text primary key,
  event_id              text not null references notification_events (id),
  binding_id            text not null references notification_bindings (id),
  account_id            text not null references accounts (id),
  channel               text not null,
  event_kind            text not null,
  status                text not null check (status in ('pending', 'sent', 'failed', 'skipped')),
  attempts              integer not null default 0,
  error_code            text,
  provider_message_id   text,
  created_at            timestamptz not null,
  updated_at            timestamptz not null,
  sent_at               timestamptz,
  unique (event_id, binding_id)
);
create index notification_deliveries_account_idx on notification_deliveries (account_id, created_at, id);
