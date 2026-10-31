BEGIN;

ALTER TABLE public.t2t_terminal_merchant_mapping
  DROP COLUMN IF EXISTS internal_mid;

COMMIT;
