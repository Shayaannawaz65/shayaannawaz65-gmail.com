BEGIN;

CREATE TABLE IF NOT EXISTS public.t2t_s2s_key_terminals (
  key_id TEXT NOT NULL
    REFERENCES public.t2t_s2s_client_keys(key_id),
  terminal_id TEXT NOT NULL
    REFERENCES public.t2t_trusted_terminals(terminal_id),
  status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'REVOKED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  PRIMARY KEY (key_id, terminal_id),
  CONSTRAINT t2t_s2s_key_terminals_revocation_consistency
    CHECK (
      (status = 'ACTIVE' AND revoked_at IS NULL)
      OR
      (status = 'REVOKED' AND revoked_at IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_t2t_s2s_key_terminals_terminal
  ON public.t2t_s2s_key_terminals (terminal_id, status);

COMMIT;
