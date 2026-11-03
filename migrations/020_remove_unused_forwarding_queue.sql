BEGIN;

-- Forwarding is intentionally disabled in T2T. Remove the unused legacy
-- queue so no deployment can mistake it for an active settlement workflow.
DROP TABLE IF EXISTS public.t2t_usdt_forwarding_jobs;

COMMIT;
