BEGIN;

CREATE TABLE IF NOT EXISTS public.tron_usdt_sync_state (
    receiver_address TEXT PRIMARY KEY,
    last_completed_timestamp TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;
