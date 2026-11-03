BEGIN;

CREATE TABLE IF NOT EXISTS public.t2t_m1_settlement_outbox (
  instruction_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id TEXT NOT NULL UNIQUE
    CHECK (transaction_id = trim(transaction_id) AND length(transaction_id) BETWEEN 1 AND 200),
  idempotency_key TEXT NOT NULL UNIQUE
    CHECK (idempotency_key = trim(idempotency_key) AND length(idempotency_key) BETWEEN 8 AND 200),
  payment_order_id UUID NOT NULL UNIQUE
    REFERENCES public.t2t_payment_orders(order_id),
  payment_order_reference TEXT NOT NULL,
  blockchain_transaction_id CHAR(64) NOT NULL,
  blockchain_event_index INTEGER NOT NULL CHECK (blockchain_event_index >= 0),
  beneficiary_code TEXT NOT NULL CHECK (beneficiary_code IN ('WISE','BARCLAYS')),
  beneficiary_snapshot JSONB NOT NULL CHECK (jsonb_typeof(beneficiary_snapshot) = 'object'),
  currency CHAR(3) NOT NULL CHECK (currency = 'USD'),
  amount_usd_cents NUMERIC(78,0) NOT NULL CHECK (amount_usd_cents > 0),
  amount_usd_decimal TEXT NOT NULL
    CHECK (amount_usd_decimal ~ '^[0-9]+(\.[0-9]+)?$'),
  settlement_currency CHAR(3),
  exchange_rate_decimal TEXT
    CHECK (exchange_rate_decimal IS NULL OR exchange_rate_decimal ~ '^[0-9]+(\.[0-9]+)?$'),
  settlement_amount_decimal TEXT
    CHECK (settlement_amount_decimal IS NULL OR settlement_amount_decimal ~ '^[0-9]+(\.[0-9]+)?$'),
  instruction_payload JSONB NOT NULL CHECK (jsonb_typeof(instruction_payload) = 'object'),
  request_payload_hash CHAR(64) NOT NULL CHECK (request_payload_hash ~ '^[0-9a-f]{64}$'),
  missing_required_fields TEXT[] NOT NULL DEFAULT '{}',
  submission_status TEXT NOT NULL DEFAULT 'BLOCKED_MISSING_REQUIRED_FIELDS'
    CHECK (submission_status IN (
      'BLOCKED_MISSING_REQUIRED_FIELDS','READY','SUBMITTING','ACCEPTED',
      'REJECTED','CONFLICT','UNKNOWN'
    )),
  http_response_status SMALLINT
    CHECK (http_response_status IS NULL OR http_response_status BETWEEN 100 AND 599),
  sanitized_response JSONB CHECK (
    sanitized_response IS NULL OR jsonb_typeof(sanitized_response) IN ('object','array')
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_attempt_at TIMESTAMPTZ,
  last_error_code TEXT,
  last_error_at TIMESTAMPTZ,
  created_by TEXT NOT NULL
    CHECK (created_by = trim(created_by) AND length(created_by) BETWEEN 1 AND 64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (blockchain_transaction_id, blockchain_event_index),
  FOREIGN KEY (blockchain_transaction_id, blockchain_event_index)
    REFERENCES public.tron_usdt_deposits(transaction_id, event_index),
  CHECK (settlement_currency IS NULL OR settlement_currency ~ '^[A-Z]{3}$'),
  CHECK (submission_status <> 'ACCEPTED' OR http_response_status = 202),
  CHECK (submission_status <> 'CONFLICT' OR http_response_status = 409),
  CHECK (submission_status <> 'SETTLED')
);

CREATE INDEX IF NOT EXISTS idx_t2t_m1_settlement_outbox_status_created
  ON public.t2t_m1_settlement_outbox(submission_status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_t2t_m1_settlement_outbox_order
  ON public.t2t_m1_settlement_outbox(payment_order_reference, created_at DESC);

COMMIT;
