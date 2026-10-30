BEGIN;

ALTER TABLE public.t2t_payment_orders
    ADD COLUMN quote_id TEXT,
    ADD COLUMN exchange_rate_numerator NUMERIC(18,0),
    ADD COLUMN exchange_rate_denominator NUMERIC(18,0),
    ADD COLUMN quote_expires_at TIMESTAMPTZ;

ALTER TABLE public.t2t_payment_orders
    ADD CONSTRAINT t2t_payment_order_quote_fields_check
    CHECK (
      (quote_id IS NULL AND exchange_rate_numerator IS NULL
       AND exchange_rate_denominator IS NULL AND quote_expires_at IS NULL)
      OR
      (quote_id IS NOT NULL
       AND exchange_rate_numerator > 0
       AND exchange_rate_denominator > 0
       AND quote_expires_at IS NOT NULL)
    );

CREATE UNIQUE INDEX uq_t2t_payment_orders_quote_id
    ON public.t2t_payment_orders (quote_id)
    WHERE quote_id IS NOT NULL;

COMMIT;
