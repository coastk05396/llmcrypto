-- 015_security_hardening: (1) idempotency claim tokens, so a stale in_flight claim that was reclaimed can never also complete;
-- (2) a pre-session binding for wallet sign-in challenges (HMAC of a cookie issued with the challenge).
-- Additive. Rollback: alter table idempotency_keys drop column claim_token; alter table wallet_challenges drop column binding_hash
-- (only after reverting the application code that reads them; challenges issued before the change simply have no binding and are
-- refused at session creation, which is the safe direction).
alter table idempotency_keys add column claim_token text;
alter table wallet_challenges add column binding_hash text;
