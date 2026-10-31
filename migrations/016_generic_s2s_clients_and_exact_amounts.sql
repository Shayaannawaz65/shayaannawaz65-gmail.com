BEGIN;

-- Generic authenticated S2S principals: BANK, MERCHANT, POS.
CREATE TABLE IF NOT EXISTS public.t2t_s2s_clients (
  client_id TEXT PRIMARY KEY
    CHECK (client_id = trim(client_id) AND length(client_id) BETWEEN 8 AND 128),
  client_type TEXT NOT NULL
    CHECK (client_type IN ('BANK', 'MERCHANT', 'POS')),
  display_name TEXT NOT NULL
    CHECK (display_name = trim(display_name) AND length(display_name) BETWEEN 1 AND 160),
  status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'REVOKED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  CHECK (
    (status = 'ACTIVE' AND revoked_at IS NULL)
    OR (status = 'REVOKED' AND revoked_at IS NOT NULL)
  )
);

-- Preserve existing keys by assigning each legacy key its own MERCHANT client.
INSERT INTO public.t2t_s2s_clients
  (client_id, client_type, display_name, status, revoked_at)
SELECT
  'legacy-merchant-' || substr(md5(k.key_id), 1, 24),
  'MERCHANT',
  'Legacy merchant key ' || k.key_id,
  k.status,
  CASE
    WHEN k.status = 'REVOKED' THEN COALESCE(k.revoked_at, NOW())
    ELSE NULL
  END
FROM public.t2t_s2s_client_keys k
ON CONFLICT (client_id) DO NOTHING;

ALTER TABLE public.t2t_s2s_client_keys
  ADD COLUMN IF NOT EXISTS client_id TEXT;

UPDATE public.t2t_s2s_client_keys
SET client_id = 'legacy-merchant-' || substr(md5(key_id), 1, 24)
WHERE client_id IS NULL;

ALTER TABLE public.t2t_s2s_client_keys
  ALTER COLUMN client_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 't2t_s2s_client_keys_client_id_fkey'
      AND conrelid = 'public.t2t_s2s_client_keys'::regclass
  ) THEN
    ALTER TABLE public.t2t_s2s_client_keys
      ADD CONSTRAINT t2t_s2s_client_keys_client_id_fkey
      FOREIGN KEY (client_id)
      REFERENCES public.t2t_s2s_clients(client_id);
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_t2t_s2s_client_keys_client
  ON public.t2t_s2s_client_keys(client_id);

-- Legacy orders without a key are retained under a POS principal per terminal.
INSERT INTO public.t2t_s2s_clients
  (client_id, client_type, display_name)
SELECT DISTINCT
  'legacy-pos-' || substr(md5(o.terminal_id), 1, 24),
  'POS',
  'Legacy POS terminal ' || o.terminal_id
FROM public.t2t_payment_orders o
WHERE o.s2s_key_id IS NULL
  AND o.terminal_id IS NOT NULL
ON CONFLICT (client_id) DO NOTHING;

ALTER TABLE public.t2t_payment_orders
  ADD COLUMN IF NOT EXISTS client_id TEXT;

UPDATE public.t2t_payment_orders o
SET client_id = k.client_id
FROM public.t2t_s2s_client_keys k
WHERE o.s2s_key_id = k.key_id
  AND o.client_id IS NULL;

UPDATE public.t2t_payment_orders o
SET client_id = 'legacy-pos-' || substr(md5(o.terminal_id), 1, 24)
WHERE o.client_id IS NULL
  AND o.terminal_id IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.t2t_payment_orders
    WHERE client_id IS NULL
  ) THEN
    RAISE EXCEPTION
      'Cannot migrate payment orders: one or more legacy orders have no client or terminal owner';
  END IF;
END
$$;

ALTER TABLE public.t2t_payment_orders
  ALTER COLUMN client_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 't2t_payment_orders_client_id_fkey'
      AND conrelid = 'public.t2t_payment_orders'::regclass
  ) THEN
    ALTER TABLE public.t2t_payment_orders
      ADD CONSTRAINT t2t_payment_orders_client_id_fkey
      FOREIGN KEY (client_id)
      REFERENCES public.t2t_s2s_clients(client_id);
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_t2t_payment_orders_client_created
  ON public.t2t_payment_orders(client_id, created_at DESC);

-- A terminal is optional for BANK/MERCHANT orders; POS authorization remains separate.
ALTER TABLE public.t2t_payment_orders
  ALTER COLUMN terminal_id DROP NOT NULL;

-- Exact decimal-string invoice cents; no JS Number monetary conversion.
ALTER TABLE public.t2t_payment_orders
  ALTER COLUMN amount_usd_cents TYPE NUMERIC(78,0)
  USING amount_usd_cents::numeric;

-- TRC20 uint256 raw amount bound.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 't2t_payment_orders_amount_usdt_uint256'
      AND conrelid = 'public.t2t_payment_orders'::regclass
  ) THEN
    ALTER TABLE public.t2t_payment_orders
      ADD CONSTRAINT t2t_payment_orders_amount_usdt_uint256
      CHECK (
        amount_usdt_raw > 0
        AND amount_usdt_raw <=
          115792089237316195423570985008687907853269984665640564039457584007913129639935
      );
  END IF;
END
$$;

-- Existing rate engine uses 18-digit fixed-point rate components.
-- Preserve that precision; it is not an invoice amount limit.

-- Rename the legacy rate-limit subject without losing counters.
ALTER TABLE public.t2t_s2s_rate_limits
  DROP CONSTRAINT IF EXISTS t2t_s2s_rate_limits_subject_type_check;

UPDATE public.t2t_s2s_rate_limits
SET subject_type = 'CLIENT_KEY'
WHERE subject_type = 'MERCHANT_KEY';

ALTER TABLE public.t2t_s2s_rate_limits
  ADD CONSTRAINT t2t_s2s_rate_limits_subject_type_check
  CHECK (subject_type IN ('CLIENT_KEY', 'TERMINAL'));

-- Remove legacy forwarding functionality and its old columns, if present.
-- Any legacy forwarding table, if present, is left untouched and unused.
ALTER TABLE public.t2t_payment_orders
  DROP COLUMN IF EXISTS forwarding_status,
  DROP COLUMN IF EXISTS forwarding_transaction_id,
  DROP COLUMN IF EXISTS forwarded_at;

COMMIT;
