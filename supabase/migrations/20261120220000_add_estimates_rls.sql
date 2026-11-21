-- =============================================================
-- Migration: 20261120220000_add_estimates_rls
--
-- Database-level tenancy for the estimates tables.
--
-- Design rules enforced here:
--   1. Authorization is derived from auth.uid() only. A client-supplied
--      account_id is data, never proof: the WITH CHECK clause re-verifies
--      membership against the authenticated identity for every write.
--   2. Membership = active account_members row, or accounts.account_manager_id,
--      or is_superadmin. Soft-removed membership (removed_at IS NOT NULL) is
--      NOT access.
--   3. Project/task assignment does NOT grant visibility into financial rows.
--      Estimates are account-level data, so the helper is deliberately
--      narrower than the app-level hasAccountAccess() (which also accepts
--      project/task assignment).
--   4. Line items inherit the parent estimate's account check; they have no
--      account_id of their own to spoof.
--   5. No DELETE policy exists on either table: hard deletes are denied for
--      every non-bypassing role.
--   6. anon loses table privileges entirely: unauthenticated requests see
--      nothing even before RLS is evaluated.
--
-- Additive and re-runnable: functions use CREATE OR REPLACE, policies are
-- dropped before creation. No table is altered, no row is touched.
-- Requires the auth schema and the anon/authenticated/service_role roles,
-- i.e. a Supabase database (same assumption as the rest of schema.sql).
-- =============================================================

-- =============================================================
-- 1. AUTHORIZATION HELPERS
--
-- SECURITY DEFINER + empty search_path: the function runs as its owner
-- (bypassing RLS on the tables it reads, so no policy recursion) while
-- every object reference is schema-qualified, so a caller cannot shadow
-- a table or function via search_path.
-- =============================================================
CREATE OR REPLACE FUNCTION public.user_has_account_access(target_account_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    auth.uid() IS NOT NULL
    AND target_account_id IS NOT NULL
    AND (
      -- Account manager owns the account.
      EXISTS (
        SELECT 1
        FROM public.accounts a
        WHERE a.id = target_account_id
          AND a.account_manager_id = auth.uid()
      )
      -- Active membership only; removed_at revokes access.
      OR EXISTS (
        SELECT 1
        FROM public.account_members am
        WHERE am.account_id = target_account_id
          AND am.user_id = auth.uid()
          AND am.removed_at IS NULL
      )
      -- Platform superadmin, matching the application's bypass rule.
      OR EXISTS (
        SELECT 1
        FROM public.user_profiles up
        WHERE up.id = auth.uid()
          AND up.is_superadmin
      )
    );
$$;

CREATE OR REPLACE FUNCTION public.user_can_access_estimate(target_estimate_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.estimates e
    WHERE e.id = target_estimate_id
      AND public.user_has_account_access(e.account_id)
  );
$$;

REVOKE ALL ON FUNCTION public.user_has_account_access(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.user_can_access_estimate(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.user_has_account_access(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.user_can_access_estimate(uuid) TO authenticated;

COMMENT ON FUNCTION public.user_has_account_access(uuid) IS
  'TRUE only when auth.uid() is an active member, the account manager, or a superadmin of the given account.';
COMMENT ON FUNCTION public.user_can_access_estimate(uuid) IS
  'TRUE only when auth.uid() has access to the account that owns the estimate.';

-- =============================================================
-- 2. ESTIMATES POLICIES (SELECT / INSERT / UPDATE, no DELETE)
-- =============================================================
DROP POLICY IF EXISTS "estimates_select_account_member" ON public.estimates;
CREATE POLICY "estimates_select_account_member" ON public.estimates
  FOR SELECT
  TO authenticated
  USING (public.user_has_account_access(account_id));

-- account_id in the submitted row is checked against the caller's real
-- membership; a forged account_id fails here even though the row itself
-- is otherwise well-formed.
DROP POLICY IF EXISTS "estimates_insert_account_member" ON public.estimates;
CREATE POLICY "estimates_insert_account_member" ON public.estimates
  FOR INSERT
  TO authenticated
  WITH CHECK (public.user_has_account_access(account_id));

-- USING guards the row as it exists (cannot touch another tenant's row);
-- WITH CHECK guards the row as it would become (cannot move it into an
-- account the caller does not belong to).
DROP POLICY IF EXISTS "estimates_update_account_member" ON public.estimates;
CREATE POLICY "estimates_update_account_member" ON public.estimates
  FOR UPDATE
  TO authenticated
  USING (public.user_has_account_access(account_id))
  WITH CHECK (public.user_has_account_access(account_id));

-- =============================================================
-- 3. ESTIMATE LINE ITEM POLICIES (SELECT / INSERT / UPDATE, no DELETE)
-- Access is inherited from the parent estimate's account.
-- =============================================================
DROP POLICY IF EXISTS "estimate_line_items_select_account_member" ON public.estimate_line_items;
CREATE POLICY "estimate_line_items_select_account_member" ON public.estimate_line_items
  FOR SELECT
  TO authenticated
  USING (public.user_can_access_estimate(estimate_id));

DROP POLICY IF EXISTS "estimate_line_items_insert_account_member" ON public.estimate_line_items;
CREATE POLICY "estimate_line_items_insert_account_member" ON public.estimate_line_items
  FOR INSERT
  TO authenticated
  WITH CHECK (public.user_can_access_estimate(estimate_id));

DROP POLICY IF EXISTS "estimate_line_items_update_account_member" ON public.estimate_line_items;
CREATE POLICY "estimate_line_items_update_account_member" ON public.estimate_line_items
  FOR UPDATE
  TO authenticated
  USING (public.user_can_access_estimate(estimate_id))
  WITH CHECK (public.user_can_access_estimate(estimate_id));

-- =============================================================
-- 4. TABLE PRIVILEGES
--
-- RLS filters rows; privileges decide whether the role may touch the
-- table at all. Both layers are required:
--   * authenticated: read and write (rows still filtered by the policies),
--   * anon: no privileges at all,
--   * service_role: unchanged, it BYPASSRLS and is server-only.
-- =============================================================
GRANT SELECT, INSERT, UPDATE ON public.estimates TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.estimate_line_items TO authenticated;

REVOKE ALL ON public.estimates FROM anon;
REVOKE ALL ON public.estimate_line_items FROM anon;

GRANT ALL ON public.estimates TO service_role;
GRANT ALL ON public.estimate_line_items TO service_role;

COMMENT ON POLICY "estimates_select_account_member" ON public.estimates IS
  'Tenant isolation: only active members/manager/superadmin of estimates.account_id may read.';
COMMENT ON POLICY "estimates_update_account_member" ON public.estimates IS
  'Tenant isolation on both the existing row and the resulting row.';
COMMENT ON POLICY "estimate_line_items_insert_account_member" ON public.estimate_line_items IS
  'A line item may only be added to an estimate whose account the caller can access.';
