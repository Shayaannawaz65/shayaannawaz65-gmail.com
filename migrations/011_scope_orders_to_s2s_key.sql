BEGIN;

ALTER TABLE public.t2t_payment_orders
  ADD COLUMN IF NOT EXISTS s2s_key_id TEXT
    REFERENCES public.t2t_s2s_client_keys(key_id);

CREATE INDEX IF NOT EXISTS idx_t2t_payment_orders_s2s_key_created
  ON public.t2t_payment_orders (s2s_key_id, created_at DESC);

COMMIT;
