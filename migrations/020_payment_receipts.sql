BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS uq_t2t_s2s_client_keys_client_key
  ON public.t2t_s2s_client_keys(client_id, key_id);

-- Internal normalized receipt ledger. CM wire fields and authentication are
-- intentionally absent; the CM adapter maps only an approved contract into it.
CREATE TABLE IF NOT EXISTS public.t2t_payment_receipts (
  receipt_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_receipt_reference TEXT NOT NULL UNIQUE
    CHECK (source_receipt_reference = trim(source_receipt_reference)
       AND length(source_receipt_reference) BETWEEN 1 AND 120),
  payment_reference TEXT NOT NULL
    CHECK (payment_reference = trim(payment_reference)
       AND length(payment_reference) BETWEEN 1 AND 120),
  currency CHAR(3) NOT NULL CHECK (currency = 'USD'),
  expected_amount_usd_cents NUMERIC(78,0) NOT NULL CHECK (expected_amount_usd_cents > 0),
  cm_reported_amount_usd_cents NUMERIC(78,0) NOT NULL CHECK (cm_reported_amount_usd_cents > 0),
  loader_received_amount_usd_cents NUMERIC(78,0)
    CHECK (loader_received_amount_usd_cents IS NULL OR loader_received_amount_usd_cents > 0),
  cm_release_status TEXT NOT NULL DEFAULT 'RELEASE_REPORTED'
    CHECK (cm_release_status IN ('RELEASE_REPORTED')),
  loader_status TEXT NOT NULL DEFAULT 'AWAITING'
    CHECK (loader_status IN ('AWAITING','RECEIVED')),
  blockchain_status TEXT NOT NULL DEFAULT 'UNVERIFIED'
    CHECK (blockchain_status IN ('UNVERIFIED','VERIFIED')),
  exchange_status TEXT NOT NULL DEFAULT 'NOT_STARTED'
    CHECK (exchange_status IN ('NOT_STARTED','CONVERTED')),
  wallet_settlement_status TEXT NOT NULL DEFAULT 'NOT_STARTED'
    CHECK (wallet_settlement_status IN ('NOT_STARTED','SETTLED')),
  cm_release_evidence_ref TEXT NOT NULL,
  loader_evidence_ref TEXT,
  blockchain_transaction_id CHAR(64),
  blockchain_event_index INTEGER CHECK (blockchain_event_index IS NULL OR blockchain_event_index >= 0),
  blockchain_token_amount_raw NUMERIC(78,0)
    CHECK (blockchain_token_amount_raw IS NULL OR blockchain_token_amount_raw > 0),
  blockchain_evidence_ref TEXT,
  exchange_evidence_ref TEXT,
  wallet_settlement_evidence_ref TEXT,
  cm_client_id TEXT NOT NULL,
  cm_key_id TEXT NOT NULL,
  cm_terminal_id TEXT NOT NULL,
  state JSONB NOT NULL CHECK (jsonb_typeof(state) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((blockchain_transaction_id IS NULL AND blockchain_event_index IS NULL)
      OR (blockchain_transaction_id ~ '^[0-9a-fA-F]{64}$' AND blockchain_event_index IS NOT NULL)),
  CHECK ((loader_status = 'AWAITING' AND loader_received_amount_usd_cents IS NULL AND loader_evidence_ref IS NULL)
      OR (loader_status = 'RECEIVED' AND loader_received_amount_usd_cents IS NOT NULL AND loader_evidence_ref IS NOT NULL)),
  CHECK ((blockchain_status = 'UNVERIFIED' AND blockchain_transaction_id IS NULL AND blockchain_evidence_ref IS NULL)
      OR (blockchain_status = 'VERIFIED' AND blockchain_transaction_id IS NOT NULL AND blockchain_evidence_ref IS NOT NULL)),
  CHECK ((exchange_status = 'NOT_STARTED' AND exchange_evidence_ref IS NULL)
      OR (exchange_status = 'CONVERTED' AND exchange_evidence_ref IS NOT NULL)),
  CHECK ((wallet_settlement_status = 'NOT_STARTED' AND wallet_settlement_evidence_ref IS NULL)
      OR (wallet_settlement_status = 'SETTLED' AND wallet_settlement_evidence_ref IS NOT NULL)),
  CHECK (blockchain_status <> 'VERIFIED' OR loader_status = 'RECEIVED'),
  CHECK (exchange_status <> 'CONVERTED' OR blockchain_status = 'VERIFIED'),
  CHECK (wallet_settlement_status <> 'SETTLED' OR exchange_status = 'CONVERTED'),
  FOREIGN KEY (cm_client_id, cm_key_id)
    REFERENCES public.t2t_s2s_client_keys(client_id, key_id),
  FOREIGN KEY (cm_key_id, cm_terminal_id)
    REFERENCES public.t2t_s2s_key_terminals(key_id, terminal_id)
);

CREATE TABLE IF NOT EXISTS public.t2t_payment_receipt_operations (
  operation_key TEXT PRIMARY KEY
    CHECK (operation_key = trim(operation_key) AND length(operation_key) BETWEEN 1 AND 200),
  receipt_id UUID NOT NULL REFERENCES public.t2t_payment_receipts(receipt_id),
  operation_type TEXT NOT NULL
    CHECK (operation_type IN ('CM-RELEASE','LOADER','BLOCKCHAIN','EXCHANGE','SETTLEMENT')),
  payload_hash CHAR(64) NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_t2t_payment_receipts_payment_reference
  ON public.t2t_payment_receipts(payment_reference, created_at DESC);

COMMIT;
