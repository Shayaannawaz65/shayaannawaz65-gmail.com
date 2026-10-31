BEGIN;

CREATE TABLE IF NOT EXISTS public.t2t_usdt_forwarding_jobs (
  job_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL UNIQUE
    REFERENCES public.t2t_payment_orders(order_id),
  source_transaction_id CHAR(64) NOT NULL
    CHECK (source_transaction_id ~ '^[0-9a-fA-F]{64}$'),
  source_event_index INTEGER NOT NULL CHECK (source_event_index >= 0),
  from_address TEXT NOT NULL
    CHECK (from_address = trim(from_address) AND length(from_address) = 34),
  destination_address TEXT,
  amount_usdt_raw NUMERIC(78,0) NOT NULL CHECK (amount_usdt_raw > 0),
  status TEXT NOT NULL DEFAULT 'AWAITING_DESTINATION'
    CHECK (status IN ('AWAITING_DESTINATION','READY','LEASED','SUBMITTED','CONFIRMED','FAILED')),
  forwarding_transaction_id CHAR(64),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_token UUID,
  lease_until TIMESTAMPTZ,
  last_error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  confirmed_at TIMESTAMPTZ,
  UNIQUE (source_transaction_id, source_event_index),
  CHECK (destination_address IS NULL OR
    (destination_address = trim(destination_address) AND length(destination_address) = 34)),
  CHECK (forwarding_transaction_id IS NULL OR
    forwarding_transaction_id ~ '^[0-9a-fA-F]{64}$')
);

CREATE INDEX IF NOT EXISTS idx_t2t_forwarding_jobs_ready
  ON public.t2t_usdt_forwarding_jobs(status, created_at)
  WHERE status IN ('AWAITING_DESTINATION','READY','FAILED');

COMMIT;
