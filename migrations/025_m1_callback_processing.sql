BEGIN;

ALTER TABLE public.t2t_m1_settlement_outbox
  ADD COLUMN IF NOT EXISTS debtor_verification_ref TEXT,
  ADD COLUMN IF NOT EXISTS settlement_status TEXT NOT NULL DEFAULT 'NOT_REPORTED',
  ADD COLUMN IF NOT EXISTS settlement_status_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS external_settlement_reference TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 't2t_m1_settlement_outbox_settlement_status_check'
      AND conrelid = 'public.t2t_m1_settlement_outbox'::regclass
  ) THEN
    ALTER TABLE public.t2t_m1_settlement_outbox
      ADD CONSTRAINT t2t_m1_settlement_outbox_settlement_status_check
      CHECK (settlement_status IN ('NOT_REPORTED','ACCEPTED','PROCESSING','SETTLED','REJECTED','UNKNOWN'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.t2t_m1_settlement_callback_events (
  callback_event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_event_id TEXT NOT NULL
    CHECK (external_event_id = trim(external_event_id) AND length(external_event_id) BETWEEN 1 AND 200),
  instruction_id UUID NOT NULL
    REFERENCES public.t2t_m1_settlement_outbox(instruction_id),
  payload_hash CHAR(64) NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  signature_verified BOOLEAN NOT NULL CHECK (signature_verified = true),
  external_status TEXT NOT NULL CHECK (length(external_status) BETWEEN 1 AND 80),
  mapped_status TEXT NOT NULL
    CHECK (mapped_status IN ('ACCEPTED','PROCESSING','SETTLED','REJECTED','UNKNOWN')),
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (external_event_id),
  UNIQUE (payload_hash)
);

CREATE INDEX IF NOT EXISTS idx_t2t_m1_callback_events_instruction
  ON public.t2t_m1_settlement_callback_events(instruction_id, received_at DESC);

COMMIT;
