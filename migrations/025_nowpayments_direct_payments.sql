BEGIN;

-- Direct NOWPayments payment details. Existing invoice columns remain for
-- backward compatibility with historical hosted-checkout orders.
ALTER TABLE public.t2t_payment_orders
  ADD COLUMN IF NOT EXISTS provider_payment_address TEXT,
  ADD COLUMN IF NOT EXISTS provider_pay_amount TEXT,
  ADD COLUMN IF NOT EXISTS provider_pay_currency TEXT;

ALTER TABLE public.t2t_payment_orders
  DROP CONSTRAINT IF EXISTS t2t_payment_orders_provider_pay_currency_check;

ALTER TABLE public.t2t_payment_orders
  ADD CONSTRAINT t2t_payment_orders_provider_pay_currency_check
  CHECK (provider_pay_currency IS NULL OR provider_pay_currency = 'usdttrc20');

COMMIT;
