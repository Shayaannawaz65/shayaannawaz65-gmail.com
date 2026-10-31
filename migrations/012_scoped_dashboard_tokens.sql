BEGIN;

ALTER TABLE public.t2t_s2s_client_keys
  ADD COLUMN IF NOT EXISTS dashboard_token_hash CHAR(64) UNIQUE
    CHECK (dashboard_token_hash IS NULL OR dashboard_token_hash ~ '^[0-9a-f]{64}$');

COMMIT;
