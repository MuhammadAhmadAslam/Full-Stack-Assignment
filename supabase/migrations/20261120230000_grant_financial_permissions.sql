-- =============================================================
-- Migration: 20261120230000_grant_financial_permissions
--
-- Grants the new estimates permissions to the seeded roles that already
-- had the matching authority. Verified in supabase/seed-roles.sql, which
-- carries the same payloads for fresh databases.
--
-- How each assignment is justified by EXISTING evidence:
--   * Account Manager  (manage_accounts, view_all_accounts,
--                       manage_projects, view_all_projects)
--       -> full estimate lifecycle: commercial terms are this role's job.
--   * Project Manager  (manage_projects, view_projects,
--                       view_team_capacity, manage_time)
--       -> author and send estimates for work they deliver, but no
--          accept/reject: those are commercial decisions and this role
--          holds no account-level authority.
--   * Executive Director (view_all_analytics, view_all_projects,
--                         view_all_departments, view_all_accounts)
--       -> read-only visibility; the role manages nothing today.
--   * Admin (manage_user_roles, manage_workflows, manage_newsletters,
--            manage_users) and Contributor / Senior Designer /
--            Senior Developer / Client
--       -> no financial permission. They hold no account or commercial
--          authority, so granting estimate access would widen their scope.
--
-- Properties:
--   * additive merge (permissions || new_keys): no existing key is removed
--     or rewritten, so non-financial permissions are untouched;
--   * scoped to three fixed seeded UUIDs and is_system_role = FALSE;
--   * custom roles are NOT touched — missing keys simply mean "denied";
--   * safe to re-run (the merge is idempotent).
-- Requires scripts/migrations 20261120210000 + 20261120220000 for the
-- permissions to have any effect on the estimates tables.
-- =============================================================

-- Account Manager: full lifecycle
UPDATE roles
SET permissions = permissions || '{
      "view_estimates": true,
      "create_estimates": true,
      "update_estimates": true,
      "send_estimates": true,
      "accept_estimates": true,
      "reject_estimates": true
    }'::jsonb
WHERE id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'
  AND is_system_role = FALSE;

-- Project Manager: author and send, no accept/reject
UPDATE roles
SET permissions = permissions || '{
      "view_estimates": true,
      "create_estimates": true,
      "update_estimates": true,
      "send_estimates": true
    }'::jsonb
WHERE id = 'ffffffff-ffff-ffff-ffff-ffffffffffff'
  AND is_system_role = FALSE;

-- Executive Director: read-only visibility
UPDATE roles
SET permissions = permissions || '{
      "view_estimates": true
    }'::jsonb
WHERE id = 'dddddddd-dddd-dddd-dddd-dddddddddddd'
  AND is_system_role = FALSE;

-- Verification (informational, no side effects):
--   SELECT id, name, permissions
--   FROM roles
--   WHERE id IN ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
--                'ffffffff-ffff-ffff-ffff-ffffffffffff',
--                'dddddddd-dddd-dddd-dddd-dddddddddddd');
