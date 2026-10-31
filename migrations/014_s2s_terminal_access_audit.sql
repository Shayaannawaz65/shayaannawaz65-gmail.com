BEGIN;

CREATE TABLE IF NOT EXISTS public.t2t_s2s_terminal_access_audit (
  audit_id BIGSERIAL PRIMARY KEY,
  key_id TEXT NOT NULL
    REFERENCES public.t2t_s2s_client_keys(key_id),
  terminal_id TEXT NOT NULL
    REFERENCES public.t2t_trusted_terminals(terminal_id),
  action TEXT NOT NULL
    CHECK (action IN ('GRANT', 'REVOKE')),
  actor_id TEXT NOT NULL
    CHECK (actor_id = trim(actor_id) AND length(actor_id) BETWEEN 1 AND 64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_t2t_s2s_terminal_access_audit_created
  ON public.t2t_s2s_terminal_access_audit (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_t2t_s2s_terminal_access_audit_mapping
  ON public.t2t_s2s_terminal_access_audit (key_id, terminal_id, created_at DESC);

COMMIT;
