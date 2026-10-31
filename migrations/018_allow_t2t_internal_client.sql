BEGIN;

ALTER TABLE public.t2t_s2s_clients
  DROP CONSTRAINT IF EXISTS t2t_s2s_clients_client_type_check;

ALTER TABLE public.t2t_s2s_clients
  ADD CONSTRAINT t2t_s2s_clients_client_type_check
  CHECK (client_type IN ('BANK', 'MERCHANT', 'POS', 'T2T_INTERNAL'));

COMMIT;
