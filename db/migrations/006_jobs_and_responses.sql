-- 006_jobs_and_responses: the job outbox that exports run through, and the OpenAI Responses protocol id.
-- Additive. Rollback: drop job_outputs/jobs and restore the two-value requests_protocol_check (only possible
-- while no openai_responses request rows exist).

-- Outbox: the API inserts a 'queued' row in the same transaction as its idempotency record; a runner claims it with
-- a conditional UPDATE (queued -> running, with a lease), so concurrent runners cannot execute one job twice.
create table jobs (
  id                  text primary key,
  account_id          text not null references accounts (id),
  created_by_user_id  text not null references users (id),
  kind                text not null check (kind in ('export')),
  params              jsonb not null,
  status              text not null check (status in ('queued', 'running', 'succeeded', 'failed', 'expired')),
  attempts            integer not null default 0,
  lease_until         timestamptz,
  created_at          timestamptz not null,
  started_at          timestamptz,
  finished_at         timestamptz,
  expires_at          timestamptz,
  error_code          text,
  error_message       text,
  row_count           bigint,
  total_microusd      numeric(30, 0)
);
create index jobs_queue_idx on jobs (created_at, id) where status in ('queued', 'running');
create index jobs_account_idx on jobs (account_id, created_at);

-- Generated file, kept only until jobs.expires_at (the runner deletes expired bodies).
create table job_outputs (
  job_id        text primary key references jobs (id),
  content_type  text not null,
  filename      text not null,
  body          text not null,
  byte_size     integer not null,
  sha256        text not null
);

alter table requests drop constraint requests_protocol_check;
alter table requests add constraint requests_protocol_check check (protocol in ('openai_chat', 'anthropic_messages', 'openai_responses'));
