BEGIN;

CREATE TABLE IF NOT EXISTS public.t2t_trusted_terminal_admin_audit (
  audit_id BIGSERIAL PRIMARY KEY,
  terminal_id TEXT NOT NULL
    REFERENCES public.t2t_trusted_terminals(terminal_id),
  action TEXT NOT NULL CHECK (action IN ('REGISTER', 'REVOKE', 'ROTATE_KEY')),
  actor_id TEXT NOT NULL
    CHECK (actor_id = trim(actor_id) AND length(actor_id) BETWEEN 1 AND 64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_t2t_trusted_terminal_admin_audit_created
  ON public.t2t_trusted_terminal_admin_audit(created_at DESC, audit_id DESC);

COMMIT;
