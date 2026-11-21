-- =============================================================
-- Idempotent estimate creation (single transaction)
--
-- One call does all of the following, or none of it:
--   1. claim (user_id, account_id, idempotency_key) — the unique
--      constraint decides the winner, so concurrent duplicates can never
--      both create an estimate;
--   2. create the estimate and its line items;
--   3. store the response envelope on the idempotency row.
--
-- Because these steps share one transaction:
--   * a failure anywhere rolls back the key too, so a retry with the same
--     key is a clean first attempt (no poisoned keys);
--   * a concurrent duplicate blocks on the unique index until the winner
--     commits, then reads the completed row and replays it.
--
-- Identity always comes from auth.uid(), never from a parameter, and
-- account membership is re-checked here because the function is
-- SECURITY DEFINER (it bypasses RLS).
-- =============================================================

CREATE OR REPLACE FUNCTION public.create_estimate_idempotent(
  p_account_id uuid,
  p_idempotency_key text,
  p_request_hash text,
  p_estimate_number text,
  p_title text,
  p_description text,
  p_currency text,
  p_project_id uuid,
  p_subtotal_minor bigint,
  p_tax_minor bigint,
  p_total_minor bigint,
  p_lines jsonb,
  p_response_status integer DEFAULT 201
)
RETURNS TABLE (
  outcome text,
  response_status integer,
  response_body jsonb,
  estimate_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_claimed_id uuid;
  v_existing public.idempotency_keys%ROWTYPE;
  v_estimate public.estimates%ROWTYPE;
  v_lines jsonb;
  v_body jsonb;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'authentication required'
      USING ERRCODE = '42501';
  END IF;

  -- Same predicate as public.user_has_account_access(): account manager,
  -- active member, or superadmin. Inlined so this function does not depend
  -- on the RLS migration having run first.
  IF p_account_id IS NULL OR NOT (
    EXISTS (
      SELECT 1
      FROM public.accounts a
      WHERE a.id = p_account_id
        AND a.account_manager_id = v_user_id
    )
    OR EXISTS (
      SELECT 1
      FROM public.account_members am
      WHERE am.account_id = p_account_id
        AND am.user_id = v_user_id
        AND am.removed_at IS NULL
    )
    OR EXISTS (
      SELECT 1
      FROM public.user_profiles up
      WHERE up.id = v_user_id
        AND up.is_superadmin = TRUE
    )
  ) THEN
    RAISE EXCEPTION 'account access denied'
      USING ERRCODE = '42501';
  END IF;

  -- 1. Claim the key. Never fails on a duplicate; the winner is whichever
  --    transaction inserts first.
  INSERT INTO public.idempotency_keys (user_id, account_id, idempotency_key, request_hash)
  VALUES (v_user_id, p_account_id, p_idempotency_key, p_request_hash)
  ON CONFLICT (user_id, account_id, idempotency_key) DO NOTHING
  RETURNING id INTO v_claimed_id;

  -- 2. Duplicate key: replay or conflict.
  IF v_claimed_id IS NULL THEN
    SELECT *
    INTO v_existing
    FROM public.idempotency_keys ik
    WHERE ik.user_id = v_user_id
      AND ik.account_id = p_account_id
      AND ik.idempotency_key = p_idempotency_key;

    IF v_existing.id IS NULL THEN
      -- Unreachable in practice; never create a duplicate on ambiguity.
      RAISE EXCEPTION 'idempotency record not visible after conflict'
        USING ERRCODE = 'P0001';
    END IF;

    IF v_existing.request_hash IS DISTINCT FROM p_request_hash THEN
      RETURN QUERY SELECT 'conflict'::text, 409, NULL::jsonb, v_existing.estimate_id;
      RETURN;
    END IF;

    IF v_existing.response_body IS NULL THEN
      RAISE EXCEPTION 'idempotency record incomplete'
        USING ERRCODE = 'P0001';
    END IF;

    RETURN QUERY SELECT
      'replay'::text,
      COALESCE(v_existing.response_status, 200),
      v_existing.response_body,
      v_existing.estimate_id;
    RETURN;
  END IF;

  -- 3. First attempt: create the estimate.
  INSERT INTO public.estimates (
    account_id, project_id, estimate_number, title, description, status,
    currency, subtotal_minor, tax_minor, total_minor, created_by
  )
  VALUES (
    p_account_id, p_project_id, p_estimate_number, p_title, p_description, 'draft',
    p_currency, p_subtotal_minor, p_tax_minor, p_total_minor, v_user_id
  )
  RETURNING * INTO v_estimate;

  -- quantity arrives as text so no float ever touches the value.
  INSERT INTO public.estimate_line_items (
    estimate_id, description, quantity, unit_price_minor, sort_order
  )
  SELECT
    v_estimate.id,
    l.description,
    l.quantity::numeric,
    l.unit_price_minor,
    l.sort_order
  FROM jsonb_to_recordset(COALESCE(p_lines, '[]'::jsonb))
    AS l(description text, quantity text, unit_price_minor bigint, sort_order integer);

  SELECT COALESCE(jsonb_agg(to_jsonb(li) ORDER BY li.sort_order, li.created_at), '[]'::jsonb)
  INTO v_lines
  FROM public.estimate_line_items li
  WHERE li.estimate_id = v_estimate.id;

  v_body := jsonb_build_object(
    'estimate', to_jsonb(v_estimate),
    'lineItems', v_lines
  );

  UPDATE public.idempotency_keys
  SET response_status = p_response_status,
      response_body = v_body,
      estimate_id = v_estimate.id,
      completed_at = now()
  WHERE id = v_claimed_id;

  RETURN QUERY SELECT 'created'::text, p_response_status, v_body, v_estimate.id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_estimate_idempotent(
  uuid, text, text, text, text, text, text, uuid, bigint, bigint, bigint, jsonb, integer
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.create_estimate_idempotent(
  uuid, text, text, text, text, text, text, uuid, bigint, bigint, bigint, jsonb, integer
) TO authenticated;

COMMENT ON FUNCTION public.create_estimate_idempotent(
  uuid, text, text, text, text, text, text, uuid, bigint, bigint, bigint, jsonb, integer
) IS
  'Atomic idempotent estimate creation: claims the key, writes the estimate and line items, stores the replay envelope. Identity from auth.uid(), membership re-checked.';
