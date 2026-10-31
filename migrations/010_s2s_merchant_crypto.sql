BEGIN;

CREATE TABLE IF NOT EXISTS public.t2t_s2s_client_keys (
  key_id TEXT PRIMARY KEY
    CHECK (key_id = trim(key_id) AND length(key_id) BETWEEN 8 AND 128),
  public_key_base64 TEXT NOT NULL
    CHECK (length(public_key_base64) BETWEEN 80 AND 1024),
  status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'REVOKED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS public.t2t_s2s_request_nonces (
  key_id TEXT NOT NULL
    REFERENCES public.t2t_s2s_client_keys(key_id),
  nonce TEXT NOT NULL
    CHECK (nonce ~ '^[a-fA-F0-9]{32,64}$'),
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (key_id, nonce)
);

CREATE INDEX IF NOT EXISTS idx_t2t_s2s_request_nonces_received
  ON public.t2t_s2s_request_nonces(received_at);

COMMIT;
