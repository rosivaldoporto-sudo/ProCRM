-- ============================================================
-- 050_distributed_rate_limits
-- Atomic rate limiting shared by every application instance.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.api_rate_limits (
  bucket_key TEXT PRIMARY KEY,
  request_count INTEGER NOT NULL,
  reset_at TIMESTAMPTZ NOT NULL
);

ALTER TABLE public.api_rate_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.api_rate_limits FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.api_rate_limits TO service_role;

CREATE OR REPLACE FUNCTION public.consume_rate_limit(
  p_key TEXT,
  p_limit INTEGER,
  p_window_ms INTEGER
)
RETURNS TABLE(success BOOLEAN, remaining INTEGER, reset BIGINT, limit_value INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count INTEGER;
  v_reset TIMESTAMPTZ;
  v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF p_key IS NULL OR length(p_key) < 1 OR length(p_key) > 500
     OR p_limit < 1 OR p_window_ms < 1000 OR p_window_ms > 86400000 THEN
    RAISE EXCEPTION 'invalid rate-limit parameters' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.api_rate_limits AS limits (bucket_key, request_count, reset_at)
  VALUES (p_key, 1, v_now + make_interval(secs => p_window_ms / 1000.0))
  ON CONFLICT (bucket_key) DO UPDATE SET
    request_count = CASE
      WHEN limits.reset_at <= v_now THEN 1
      ELSE limits.request_count + 1
    END,
    reset_at = CASE
      WHEN limits.reset_at <= v_now
        THEN v_now + make_interval(secs => p_window_ms / 1000.0)
      ELSE limits.reset_at
    END
  RETURNING request_count, reset_at INTO v_count, v_reset;

  RETURN QUERY SELECT
    v_count <= p_limit,
    GREATEST(p_limit - v_count, 0),
    floor(extract(epoch FROM v_reset) * 1000)::BIGINT,
    p_limit;
END;
$$;

REVOKE ALL ON FUNCTION public.consume_rate_limit(TEXT, INTEGER, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_rate_limit(TEXT, INTEGER, INTEGER)
  TO service_role;
