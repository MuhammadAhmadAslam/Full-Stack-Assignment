-- =============================================================
-- Migration: 20261121020000_align_status_checks
--
-- Why: the original schema constraints did not accept the values the
-- application and scripts/create-seed-users.ts actually write.
--
--   accounts: CHECK was ('planning','in_progress','review','complete',
--             'on_hold') -- a copy of the PROJECT status list. Account
--             status is 'active' | 'inactive' | 'suspended' | 'archived'
--             (see components/account-create-dialog.tsx and
--             lib/validation-schemas.ts), and seed data inserts 'active',
--             so seeding failed with 23514.
--   projects: seed data and the project UI use 'active'; it was missing.
--   tasks:    lib/validation-schemas.ts allows backlog/review/blocked and
--             the kanban UI uses 'review'; they were missing.
--
-- Safe and idempotent: the auto-named inline constraints are dropped if
-- present (PostgreSQL names them <table>_status_check), then re-added
-- under explicit names. Re-running this file is a no-op net effect.
--
-- Precondition: no existing row holds a status outside the new list.
-- This is true for a fresh bootstrap. If this migration fails while
-- adding a constraint, inspect the offending rows first:
--   SELECT status, count(*) FROM accounts GROUP BY 1;
-- =============================================================

-- ACCOUNTS
ALTER TABLE public.accounts DROP CONSTRAINT IF EXISTS accounts_status_check;
ALTER TABLE public.accounts DROP CONSTRAINT IF EXISTS accounts_status_valid;
ALTER TABLE public.accounts
  ADD CONSTRAINT accounts_status_valid
  CHECK (status IN ('active','inactive','suspended','archived'));
ALTER TABLE public.accounts ALTER COLUMN status SET DEFAULT 'active';

-- PROJECTS
ALTER TABLE public.projects DROP CONSTRAINT IF EXISTS projects_status_check;
ALTER TABLE public.projects DROP CONSTRAINT IF EXISTS projects_status_valid;
ALTER TABLE public.projects
  ADD CONSTRAINT projects_status_valid
  CHECK (status IN ('planning','in_progress','active','review','complete','on_hold'));

-- TASKS
ALTER TABLE public.tasks DROP CONSTRAINT IF EXISTS tasks_status_check;
ALTER TABLE public.tasks DROP CONSTRAINT IF EXISTS tasks_status_valid;
ALTER TABLE public.tasks
  ADD CONSTRAINT tasks_status_valid
  CHECK (status IN ('backlog','todo','in_progress','review','done','blocked','complete'));
