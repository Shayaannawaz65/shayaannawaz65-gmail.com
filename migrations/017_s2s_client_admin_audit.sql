BEGIN;

CREATE TABLE IF NOT EXISTS public.t2t_s2s_client_admin_audit (
  audit_id BIGSERIAL PRIMARY KEY,
  client_id TEXT REFERENCES public.t2t_s2s_clients(client_id),
  key_id TEXT REFERENCES public.t2t_s2s_client_keys(key_id),
  action TEXT NOT NULL CHECK (
    action IN ('CREATE_CLIENT', 'REGISTER_KEY', 'REVOKE_CLIENT', 'REVOKE_KEY')
  ),
  actor_id TEXT NOT NULL
    CHECK (actor_id = trim(actor_id) AND length(actor_id) BETWEEN 1 AND 64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_t2t_s2s_client_admin_audit_created
  ON public.t2t_s2s_client_admin_audit(created_at DESC, audit_id DESC);

CREATE INDEX IF NOT EXISTS idx_t2t_s2s_client_admin_audit_client
  ON public.t2t_s2s_client_admin_audit(client_id, created_at DESC);

COMMIT;
