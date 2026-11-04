BEGIN;

-- Direct NOWPayments payment details. Existing invoice columns remain for
-- backward compatibility with historical hosted-checkout orders.
ALTER TABLE public.t2t_payment_orders
  ADD COLUMN IF NOT EXISTS provider_payment_address TEXT,
  ADD COLUMN IF NOT EXISTS provider_pay_amount TEXT,
  ADD COLUMN IF NOT EXISTS provider_pay_currency TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 't2t_payment_orders_provider_pay_currency_check'
       AND conrelid = 'public.t2t_payment_orders'::regclass
  ) THEN
    ALTER TABLE public.t2t_payment_orders
      ADD CONSTRAINT t2t_payment_orders_provider_pay_currency_check
      CHECK (provider_pay_currency IS NULL OR provider_pay_currency = 'usdttrc20');
  END IF;
END
$$;

COMMIT;
