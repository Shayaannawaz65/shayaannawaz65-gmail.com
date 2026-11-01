BEGIN;

ALTER TABLE public.t2t_payment_orders
  DROP CONSTRAINT IF EXISTS t2t_payment_orders_invoice_reference_key;

CREATE UNIQUE INDEX IF NOT EXISTS uq_t2t_payment_orders_client_invoice
  ON public.t2t_payment_orders (client_id, invoice_reference);

COMMIT;
