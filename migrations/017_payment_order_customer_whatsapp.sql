ALTER TABLE public.t2t_payment_orders
ADD COLUMN IF NOT EXISTS customer_whatsapp_number text;
