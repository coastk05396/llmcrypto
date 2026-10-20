-- Credential generation invalidates proofs verified before recovery, including within one clock tick.
-- Session issuance, recovery and method removal serialize on the corresponding users row.
-- Rollback: alter table users drop column auth_version (only after reverting the application readers/writers that compare it).
alter table users add column auth_version integer not null default 0 check (auth_version >= 0);
