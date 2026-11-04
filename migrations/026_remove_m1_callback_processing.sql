BEGIN;

-- SKIT has confirmed it never emits callbacks. Remove only callback-event
-- persistence. Preserve settlement_status fields: a future, separately
-- contracted payout/reconciliation process may populate them independently.
DROP TABLE IF EXISTS public.t2t_m1_settlement_callback_events;

COMMIT;
