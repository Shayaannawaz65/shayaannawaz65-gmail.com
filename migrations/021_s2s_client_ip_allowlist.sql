BEGIN;

CREATE TABLE IF NOT EXISTS public.t2t_s2s_client_ip_allowlist (
  allowlist_id BIGSERIAL PRIMARY KEY,
  client_id TEXT NOT NULL
    REFERENCES public.t2t_s2s_clients(client_id),
  network CIDR NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'REVOKED')),
  created_by TEXT NOT NULL
    CHECK (created_by = trim(created_by) AND length(created_by) BETWEEN 1 AND 64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (client_id, network)
);

CREATE INDEX IF NOT EXISTS idx_t2t_s2s_client_ip_allowlist_active
  ON public.t2t_s2s_client_ip_allowlist(client_id, network)
  WHERE status = 'ACTIVE';

CREATE TABLE IF NOT EXISTS public.t2t_s2s_client_ip_audit (
  audit_id BIGSERIAL PRIMARY KEY,
  client_id TEXT NOT NULL
    REFERENCES public.t2t_s2s_clients(client_id),
  network CIDR NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('ALLOW', 'REVOKE')),
  actor_id TEXT NOT NULL
    CHECK (actor_id = trim(actor_id) AND length(actor_id) BETWEEN 1 AND 64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_t2t_s2s_client_ip_audit_created
  ON public.t2t_s2s_client_ip_audit(created_at DESC, audit_id DESC);

COMMIT;
