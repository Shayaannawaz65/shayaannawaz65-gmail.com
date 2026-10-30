BEGIN;

ALTER TABLE public.t2t_payment_orders
  ADD COLUMN IF NOT EXISTS exchange_rate_metadata JSONB
  NOT NULL DEFAULT '{}'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 't2t_payment_orders_exchange_rate_metadata_object'
       AND conrelid = 'public.t2t_payment_orders'::regclass
  ) THEN
    ALTER TABLE public.t2t_payment_orders
      ADD CONSTRAINT t2t_payment_orders_exchange_rate_metadata_object
      CHECK (jsonb_typeof(exchange_rate_metadata) = 'object');
  END IF;
END
$$;

COMMIT;
