-- Provider completion time is distinct from delayed financial settlement.
-- Existing rows retain unknown provider finish metadata (no fabricated backfill).
-- Rollback: drop response_finished_at and finish_reason only after reverting the application reader/writer.
alter table requests add column response_finished_at timestamptz;
alter table requests add column finish_reason text;
