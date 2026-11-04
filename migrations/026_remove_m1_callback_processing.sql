BEGIN;

DROP TABLE IF EXISTS public.t2t_m1_settlement_callback_events;

ALTER TABLE public.t2t_m1_settlement_outbox
  DROP COLUMN IF EXISTS settlement_status,
  DROP COLUMN IF EXISTS settlement_status_at,
  DROP COLUMN IF EXISTS external_settlement_reference;

COMMIT;
