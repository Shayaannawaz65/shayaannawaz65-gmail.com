ALTER TABLE public.tron_usdt_sync_state
  ADD COLUMN IF NOT EXISTS lease_token UUID,
  ADD COLUMN IF NOT EXISTS lease_until TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS tron_usdt_sync_lease_until_idx
  ON public.tron_usdt_sync_state (lease_until);
