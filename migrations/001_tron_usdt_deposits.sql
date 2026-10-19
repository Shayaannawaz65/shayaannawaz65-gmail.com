BEGIN;

CREATE TABLE IF NOT EXISTS public.tron_usdt_deposits (
    transaction_id       CHAR(64) NOT NULL,
    event_index           INTEGER NOT NULL CHECK (event_index >= 0),
    sender_address        TEXT NOT NULL,
    receiver_address      TEXT NOT NULL,
    token_contract        TEXT NOT NULL
        CHECK (token_contract = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'),
    amount_raw            NUMERIC(78, 0) NOT NULL CHECK (amount_raw > 0),
    amount_usdt           NUMERIC(30, 6) NOT NULL CHECK (amount_usdt > 0),
    block_timestamp       TIMESTAMPTZ NOT NULL,
    observation_status    TEXT NOT NULL DEFAULT 'OBSERVED_CONFIRMED'
        CHECK (observation_status = 'OBSERVED_CONFIRMED'),
    first_seen_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    raw_event_json        JSONB NOT NULL,
    PRIMARY KEY (transaction_id, event_index)
);

CREATE INDEX IF NOT EXISTS idx_tron_usdt_deposits_receiver_time
    ON public.tron_usdt_deposits (receiver_address, block_timestamp DESC);

COMMIT;
