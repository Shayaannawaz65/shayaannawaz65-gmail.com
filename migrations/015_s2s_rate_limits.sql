CREATE TABLE IF NOT EXISTS public.t2t_s2s_rate_limits (
    subject_type TEXT NOT NULL
        CHECK (subject_type IN ('MERCHANT_KEY', 'TERMINAL')),
    subject_id VARCHAR(128) NOT NULL,
    endpoint VARCHAR(40) NOT NULL
        CHECK (endpoint IN ('payment-orders', 'payment-quotes', 'heartbeat')),
    window_started_at TIMESTAMPTZ NOT NULL,
    request_count INTEGER NOT NULL CHECK (request_count > 0),
    PRIMARY KEY (subject_type, subject_id, endpoint)
);
