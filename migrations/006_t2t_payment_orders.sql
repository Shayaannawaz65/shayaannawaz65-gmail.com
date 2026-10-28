BEGIN;

CREATE TABLE public.t2t_payment_orders (
    order_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    terminal_id TEXT NOT NULL
        REFERENCES public.t2t_trusted_terminals(terminal_id),

    invoice_reference TEXT NOT NULL UNIQUE
        CHECK (
            invoice_reference = trim(invoice_reference)
            AND length(invoice_reference) BETWEEN 1 AND 120
        ),

    currency CHAR(3) NOT NULL DEFAULT 'USD'
        CHECK (currency = 'USD'),

    amount_usd_cents BIGINT NOT NULL
        CHECK (amount_usd_cents > 0),

    token_contract TEXT NOT NULL
        DEFAULT 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
        CHECK (
            token_contract = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
        ),

    amount_usdt_raw NUMERIC(78, 0) NOT NULL
        CHECK (amount_usdt_raw > 0),

    receiver_address TEXT NOT NULL
        CHECK (
            receiver_address = trim(receiver_address)
            AND length(receiver_address) = 34
        ),

    payment_token_hash CHAR(64) NOT NULL UNIQUE
        CHECK (payment_token_hash ~ '^[0-9a-f]{64}$'),

    status TEXT NOT NULL DEFAULT 'PENDING'
        CHECK (
            status IN (
                'PENDING',
                'CONFIRMED',
                'EXPIRED',
                'CANCELLED'
            )
        ),

    matched_transaction_id CHAR(64),
    matched_event_index INTEGER,

    forwarding_status TEXT NOT NULL DEFAULT 'NOT_STARTED'
        CHECK (
            forwarding_status IN (
                'NOT_STARTED',
                'PENDING',
                'SUBMITTED',
                'CONFIRMED',
                'FAILED'
            )
        ),

    forwarding_transaction_id CHAR(64),

    expires_at TIMESTAMPTZ NOT NULL,
    confirmed_at TIMESTAMPTZ,
    forwarded_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CHECK (
        (matched_transaction_id IS NULL AND matched_event_index IS NULL)
        OR
        (
            matched_transaction_id ~ '^[0-9a-fA-F]{64}$'
            AND matched_event_index >= 0
        )
    ),

    CHECK (
        forwarding_transaction_id IS NULL
        OR forwarding_transaction_id ~ '^[0-9a-fA-F]{64}$'
    )
);

CREATE INDEX idx_t2t_payment_orders_pending_expiry
    ON public.t2t_payment_orders (expires_at)
    WHERE status = 'PENDING';

CREATE INDEX idx_t2t_payment_orders_status_created
    ON public.t2t_payment_orders (status, created_at DESC);

CREATE UNIQUE INDEX uq_t2t_payment_orders_matched_event
    ON public.t2t_payment_orders (
        matched_transaction_id,
        matched_event_index
    )
    WHERE matched_transaction_id IS NOT NULL;

COMMIT;
