BEGIN;

CREATE TABLE IF NOT EXISTS public.t2t_trusted_terminals (
    terminal_id TEXT PRIMARY KEY,
    public_key_base64 TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ACTIVE'
        CHECK (status IN ('ACTIVE', 'REVOKED')),
    last_seen_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.t2t_heartbeat_nonces (
    terminal_id TEXT NOT NULL
        REFERENCES public.t2t_trusted_terminals(terminal_id),
    nonce TEXT NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (terminal_id, nonce)
);

CREATE INDEX IF NOT EXISTS idx_t2t_heartbeat_nonces_received
    ON public.t2t_heartbeat_nonces(received_at);

COMMIT;
