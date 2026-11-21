-- =============================================================
-- 40. IDEMPOTENCY KEYS
--
-- Backs idempotent estimate creation. The unique constraint on
-- (user_id, account_id, idempotency_key) is the ONLY thing that decides
-- who wins a concurrent retry — no application-level check, cache or
-- in-memory map participates in the decision.
--
-- Retention: rows are kept for 30 days (see
-- public.purge_expired_idempotency_keys below). After that a client that
-- replays an old key is treated as a new request. 30 days comfortably
-- exceeds any retry window for a mobile/web client, while keeping the
-- table small.
--
-- Capabilities: RLS is enabled with NO policies. Only SECURITY DEFINER
-- functions (and service_role) may read or write, so a client cannot
-- forge or probe another user's keys.
-- =============================================================

CREATE TABLE IF NOT EXISTS public.idempotency_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  response_status integer,
  response_body jsonb,
  estimate_id uuid REFERENCES public.estimates(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,

  CONSTRAINT idempotency_keys_key_length
    CHECK (char_length(idempotency_key) BETWEEN 8 AND 255),
  CONSTRAINT idempotency_keys_hash_format
    CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT idempotency_keys_scope_unique
    UNIQUE (user_id, account_id, idempotency_key)
);

-- Supports the retention sweep.
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_created_at
  ON public.idempotency_keys (created_at);

ALTER TABLE public.idempotency_keys ENABLE ROW LEVEL SECURITY;

-- No policies on purpose: deny-by-default for anon/authenticated.
GRANT ALL ON public.idempotency_keys TO service_role;

COMMENT ON TABLE public.idempotency_keys IS
  'Processed idempotent requests. Unique per (user, account, key); the unique constraint arbitrates concurrent retries.';
COMMENT ON COLUMN public.idempotency_keys.request_hash IS
  'SHA-256 hex of the canonical (normalised) request payload. Same key + different hash = 409.';
COMMENT ON COLUMN public.idempotency_keys.response_body IS
  'Stored response envelope (estimate + line items) replayed verbatim for duplicates.';
COMMENT ON COLUMN public.idempotency_keys.estimate_id IS
  'Estimate created by the original request; traceability only.';

-- =============================================================
-- Retention sweep
--
-- Not scheduled automatically (the project has no cron wiring); call it
-- from a scheduled job / maintenance task. Only service_role may run it.
-- =============================================================
CREATE OR REPLACE FUNCTION public.purge_expired_idempotency_keys(
  p_retention interval DEFAULT interval '30 days'
)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH purged AS (
    DELETE FROM public.idempotency_keys
    WHERE created_at < now() - p_retention
    RETURNING 1
  )
  SELECT count(*)::integer FROM purged;
$$;

REVOKE ALL ON FUNCTION public.purge_expired_idempotency_keys(interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.purge_expired_idempotency_keys(interval) TO service_role;

COMMENT ON FUNCTION public.purge_expired_idempotency_keys(interval) IS
  'Deletes idempotency records older than the retention window (default 30 days). service_role only.';
