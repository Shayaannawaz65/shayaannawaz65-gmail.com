BEGIN;

CREATE TABLE IF NOT EXISTS public.t2t_terminal_merchant_mapping (
    terminal_id TEXT PRIMARY KEY
        REFERENCES public.t2t_trusted_terminals(terminal_id),

    internal_mid TEXT NOT NULL UNIQUE
        CHECK (
            internal_mid = trim(internal_mid)
            AND length(internal_mid) BETWEEN 1 AND 100
        ),

    receiver_id TEXT NOT NULL UNIQUE
        CHECK (
            receiver_id = trim(receiver_id)
            AND length(receiver_id) BETWEEN 1 AND 100
        ),

    receiver_address TEXT NOT NULL
        CHECK (
            receiver_address = trim(receiver_address)
            AND length(receiver_address) BETWEEN 1 AND 100
        ),

    status TEXT NOT NULL DEFAULT 'INACTIVE'
        CHECK (status IN ('ACTIVE', 'INACTIVE', 'REVOKED')),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS
    idx_t2t_terminal_merchant_mapping_status
    ON public.t2t_terminal_merchant_mapping (status);

CREATE OR REPLACE FUNCTION
    public.t2t_update_merchant_mapping_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
    trg_t2t_merchant_mapping_updated_at
    ON public.t2t_terminal_merchant_mapping;

CREATE TRIGGER trg_t2t_merchant_mapping_updated_at
BEFORE UPDATE ON public.t2t_terminal_merchant_mapping
FOR EACH ROW
EXECUTE FUNCTION public.t2t_update_merchant_mapping_updated_at();

COMMIT;
