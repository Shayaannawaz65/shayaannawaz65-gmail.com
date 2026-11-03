BEGIN;

ALTER TABLE public.t2t_payment_orders
  ADD COLUMN IF NOT EXISTS provider_name TEXT,
  ADD COLUMN IF NOT EXISTS provider_invoice_id TEXT,
  ADD COLUMN IF NOT EXISTS provider_invoice_url TEXT,
  ADD COLUMN IF NOT EXISTS provider_payment_id TEXT,
  ADD COLUMN IF NOT EXISTS provider_payment_status TEXT,
  ADD COLUMN IF NOT EXISTS provider_payload JSONB;

ALTER TABLE public.t2t_payment_orders
  DROP CONSTRAINT IF EXISTS t2t_payment_orders_status_check;

ALTER TABLE public.t2t_payment_orders
  ADD CONSTRAINT t2t_payment_orders_status_check
  CHECK (status IN (
    'PENDING',
    'PROCESSING',
    'CONFIRMED',
    'PARTIALLY_PAID',
    'FAILED',
    'REFUNDED',
    'EXPIRED',
    'CANCELLED',
    'PROVIDER_ERROR'
  ));

CREATE UNIQUE INDEX IF NOT EXISTS uq_t2t_payment_orders_provider_invoice
  ON public.t2t_payment_orders(provider_invoice_id)
  WHERE provider_invoice_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_t2t_payment_orders_provider_payment
  ON public.t2t_payment_orders(provider_payment_id)
  WHERE provider_payment_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.t2t_nowpayments_ipn_events (
  event_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  payload_hash CHAR(64) NOT NULL UNIQUE
    CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  payment_id TEXT NOT NULL,
  payment_status TEXT NOT NULL,
  payload JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_t2t_nowpayments_ipn_payment
  ON public.t2t_nowpayments_ipn_events(payment_id, received_at DESC);

COMMIT;
