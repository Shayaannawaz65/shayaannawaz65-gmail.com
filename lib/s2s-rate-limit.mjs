export async function consumeS2sRateLimit(client, {
  subjectType, subjectId, endpoint, limit, now = Date.now(), windowMs = 60000
}) {
  const result = await client.query(
    `INSERT INTO public.t2t_s2s_rate_limits
       (subject_type, subject_id, endpoint, window_started_at, request_count)
     VALUES ($1, $2, $3, to_timestamp($4 / 1000.0), 1)
     ON CONFLICT (subject_type, subject_id, endpoint)
     DO UPDATE SET
       request_count = CASE
         WHEN public.t2t_s2s_rate_limits.window_started_at
              <= EXCLUDED.window_started_at - ($5 * INTERVAL '1 millisecond')
         THEN 1
         ELSE public.t2t_s2s_rate_limits.request_count + 1
       END,
       window_started_at = CASE
         WHEN public.t2t_s2s_rate_limits.window_started_at
              <= EXCLUDED.window_started_at - ($5 * INTERVAL '1 millisecond')
         THEN EXCLUDED.window_started_at
         ELSE public.t2t_s2s_rate_limits.window_started_at
       END
     RETURNING request_count`,
    [subjectType, subjectId, endpoint, now, windowMs]
  );
  return Number(result.rows[0]?.request_count) <= limit;
}
