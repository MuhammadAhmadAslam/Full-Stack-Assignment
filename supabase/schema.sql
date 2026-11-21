
-- =============================================================
-- KONTRORA / NIXORA - COMPLETE DATABASE SCHEMA
-- Run this in the Supabase SQL Editor (Dashboard → SQL Editor)
-- =============================================================

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- =============================================================
-- HELPER: auto-update updated_at on every UPDATE
-- =============================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- =============================================================
-- 1. DEPARTMENTS
-- =============================================================
CREATE TABLE IF NOT EXISTS departments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_departments_updated_at
  BEFORE UPDATE ON departments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE departments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "departments_service_role_all" ON departments
  USING (TRUE) WITH CHECK (TRUE);

-- =============================================================
-- 2. ROLES
-- =============================================================
CREATE TABLE IF NOT EXISTS roles (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name              TEXT NOT NULL,
  description       TEXT,
  department_id     UUID REFERENCES departments(id) ON DELETE SET NULL,
  permissions       JSONB NOT NULL DEFAULT '{}',
  hierarchy_level   INTEGER NOT NULL DEFAULT 0,
  reporting_role_id UUID REFERENCES roles(id) ON DELETE SET NULL,
  is_system_role    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_roles_updated_at
  BEFORE UPDATE ON roles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE INDEX IF NOT EXISTS idx_roles_department_id ON roles(department_id);

ALTER TABLE roles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "roles_service_role_all" ON roles
  USING (TRUE) WITH CHECK (TRUE);

-- =============================================================
-- 3. USER PROFILES
-- (mirrors auth.users — populated via trigger on signup)
-- =============================================================
CREATE TABLE IF NOT EXISTS user_profiles (
  id                      UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email                   TEXT NOT NULL UNIQUE,
  name                    TEXT,
  image                   TEXT,
  bio                     TEXT,
  skills                  TEXT[] NOT NULL DEFAULT '{}',
  is_superadmin           BOOLEAN NOT NULL DEFAULT FALSE,
  is_client               BOOLEAN NOT NULL DEFAULT FALSE,
  client_account_id       UUID,  -- FK added after accounts table
  client_contact_name     TEXT,
  client_company_position TEXT,
  workload_sentiment      TEXT CHECK (workload_sentiment IN ('comfortable','stretched','overwhelmed')),
  has_completed_onboarding BOOLEAN NOT NULL DEFAULT FALSE,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_user_profiles_updated_at
  BEFORE UPDATE ON user_profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE INDEX IF NOT EXISTS idx_user_profiles_email ON user_profiles(email);

ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_profiles_service_role_all" ON user_profiles
  USING (TRUE) WITH CHECK (TRUE);

-- Allow users to read their own profile
CREATE POLICY "user_profiles_read_own" ON user_profiles
  FOR SELECT USING (auth.uid() = id);

-- =============================================================
-- 4. USER ROLES  (junction: user ↔ role, soft-deletable)
-- =============================================================
CREATE TABLE IF NOT EXISTS user_roles (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  role_id     UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  assigned_by UUID REFERENCES user_profiles(id) ON DELETE SET NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  removed_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_user_roles_user_id   ON user_roles(user_id);
CREATE INDEX IF NOT EXISTS idx_user_roles_role_id   ON user_roles(role_id);
CREATE INDEX IF NOT EXISTS idx_user_roles_active     ON user_roles(user_id, role_id) WHERE removed_at IS NULL;

ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_roles_service_role_all" ON user_roles
  USING (TRUE) WITH CHECK (TRUE);

-- =============================================================
-- 5. ACCOUNTS  (client accounts / companies)
-- =============================================================
CREATE TABLE IF NOT EXISTS accounts (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  TEXT NOT NULL,
  description           TEXT,
  status                TEXT NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active','inactive','suspended','archived')),
  primary_contact_name  TEXT,
  primary_contact_email TEXT,
  account_manager_id    UUID REFERENCES user_profiles(id) ON DELETE SET NULL,
  service_tier          TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_accounts_updated_at
  BEFORE UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE INDEX IF NOT EXISTS idx_accounts_account_manager ON accounts(account_manager_id);

ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "accounts_service_role_all" ON accounts
  USING (TRUE) WITH CHECK (TRUE);

-- Now that accounts exists, add the FK on user_profiles
ALTER TABLE user_profiles
  ADD CONSTRAINT fk_user_profiles_client_account
  FOREIGN KEY (client_account_id) REFERENCES accounts(id) ON DELETE SET NULL;

-- =============================================================
-- 6. ACCOUNT MEMBERS  (junction: account ↔ user, soft-deletable)
-- =============================================================
CREATE TABLE IF NOT EXISTS account_members (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  role_in_account TEXT,
  assigned_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  removed_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_account_members_account ON account_members(account_id) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_account_members_user    ON account_members(user_id)    WHERE removed_at IS NULL;

ALTER TABLE account_members ENABLE ROW LEVEL SECURITY;

CREATE POLICY "account_members_service_role_all" ON account_members
  USING (TRUE) WITH CHECK (TRUE);

-- =============================================================
-- 7. ACCOUNT KANBAN CONFIGS
-- =============================================================
CREATE TABLE IF NOT EXISTS account_kanban_configs (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  columns    JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_account_kanban_configs_updated_at
  BEFORE UPDATE ON account_kanban_configs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE account_kanban_configs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "account_kanban_configs_service_role_all" ON account_kanban_configs
  USING (TRUE) WITH CHECK (TRUE);

-- =============================================================
-- 8. PROJECTS
-- =============================================================
CREATE TABLE IF NOT EXISTS projects (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  description     TEXT,
  account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  status          TEXT NOT NULL DEFAULT 'planning'
                    CHECK (status IN ('planning','in_progress','active','review','complete','on_hold')),
  priority        TEXT NOT NULL DEFAULT 'medium'
                    CHECK (priority IN ('low','medium','high','urgent')),
  start_date      DATE,
  end_date        DATE,
  estimated_hours NUMERIC(10,2),
  actual_hours    NUMERIC(10,2),
  created_by      UUID REFERENCES user_profiles(id) ON DELETE SET NULL,
  assigned_user_id UUID REFERENCES user_profiles(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_projects_updated_at
  BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE INDEX IF NOT EXISTS idx_projects_account_id  ON projects(account_id);
CREATE INDEX IF NOT EXISTS idx_projects_created_by  ON projects(created_by);
CREATE INDEX IF NOT EXISTS idx_projects_status      ON projects(status);

ALTER TABLE projects ENABLE ROW LEVEL SECURITY;

CREATE POLICY "projects_service_role_all" ON projects
  USING (TRUE) WITH CHECK (TRUE);

-- =============================================================
-- 9. PROJECT ASSIGNMENTS  (junction: project ↔ user, soft-deletable)
-- =============================================================
CREATE TABLE IF NOT EXISTS project_assignments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  role_in_project TEXT,
  assigned_by     UUID REFERENCES user_profiles(id) ON DELETE SET NULL,
  assigned_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  removed_at      TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_project_assignments_updated_at
  BEFORE UPDATE ON project_assignments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE INDEX IF NOT EXISTS idx_project_assignments_project ON project_assignments(project_id) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_project_assignments_user    ON project_assignments(user_id)    WHERE removed_at IS NULL;

ALTER TABLE project_assignments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "project_assignments_service_role_all" ON project_assignments
  USING (TRUE) WITH CHECK (TRUE);

-- =============================================================
-- 10. PROJECT STAKEHOLDERS
-- =============================================================
CREATE TABLE IF NOT EXISTS project_stakeholders (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  role        TEXT,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_project_stakeholders_project ON project_stakeholders(project_id);

ALTER TABLE project_stakeholders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "project_stakeholders_service_role_all" ON project_stakeholders
  USING (TRUE) WITH CHECK (TRUE);

-- =============================================================
-- 11. PROJECT UPDATES
-- =============================================================
CREATE TABLE IF NOT EXISTS project_updates (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  content    TEXT NOT NULL,
  created_by UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_project_updates_updated_at
  BEFORE UPDATE ON project_updates
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE INDEX IF NOT EXISTS idx_project_updates_project ON project_updates(project_id);

ALTER TABLE project_updates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "project_updates_service_role_all" ON project_updates
  USING (TRUE) WITH CHECK (TRUE);

-- =============================================================
-- 12. PROJECT ISSUES
-- =============================================================
CREATE TABLE IF NOT EXISTS project_issues (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  content             TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open','in_progress','resolved')),
  created_by          UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  resolved_by         UUID REFERENCES user_profiles(id) ON DELETE SET NULL,
  resolved_at         TIMESTAMPTZ,
  workflow_history_id UUID,  -- FK added after workflow_history table
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_project_issues_updated_at
  BEFORE UPDATE ON project_issues
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE INDEX IF NOT EXISTS idx_project_issues_project ON project_issues(project_id);
CREATE INDEX IF NOT EXISTS idx_project_issues_status  ON project_issues(status);

ALTER TABLE project_issues ENABLE ROW LEVEL SECURITY;

CREATE POLICY "project_issues_service_role_all" ON project_issues
  USING (TRUE) WITH CHECK (TRUE);

-- =============================================================
-- 13. MILESTONES
-- =============================================================
CREATE TABLE IF NOT EXISTS milestones (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  description TEXT,
  date        TIMESTAMPTZ NOT NULL,
  color       TEXT NOT NULL DEFAULT '#3b82f6',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_milestones_updated_at
  BEFORE UPDATE ON milestones
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE milestones ENABLE ROW LEVEL SECURITY;

CREATE POLICY "milestones_service_role_all" ON milestones
  USING (TRUE) WITH CHECK (TRUE);

-- =============================================================
-- 14. TASKS
-- =============================================================
CREATE TABLE IF NOT EXISTS tasks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  description     TEXT,
  status          TEXT NOT NULL DEFAULT 'todo'
                    CHECK (status IN ('backlog','todo','in_progress','review','done','blocked','complete')),
  priority        TEXT CHECK (priority IN ('low','medium','high','urgent')),
  assigned_to     UUID REFERENCES user_profiles(id) ON DELETE SET NULL,
  created_by      UUID REFERENCES user_profiles(id) ON DELETE SET NULL,
  due_date        DATE,
  estimated_hours NUMERIC(10,2),
  remaining_hours NUMERIC(10,2),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_tasks_updated_at
  BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE INDEX IF NOT EXISTS idx_tasks_project_id  ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_assigned_to ON tasks(assigned_to);
CREATE INDEX IF NOT EXISTS idx_tasks_status      ON tasks(status);

ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tasks_service_role_all" ON tasks
  USING (TRUE) WITH CHECK (TRUE);

-- =============================================================
-- 15. TASK WEEK ALLOCATIONS
-- =============================================================
CREATE TABLE IF NOT EXISTS task_week_allocations (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id          UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  assigned_user_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  week_start_date  DATE NOT NULL,
  allocated_hours  NUMERIC(10,2) NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_task_week_allocations_updated_at
  BEFORE UPDATE ON task_week_allocations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE INDEX IF NOT EXISTS idx_task_week_alloc_task ON task_week_allocations(task_id);
CREATE INDEX IF NOT EXISTS idx_task_week_alloc_user ON task_week_allocations(assigned_user_id, week_start_date);

ALTER TABLE task_week_allocations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "task_week_allocations_service_role_all" ON task_week_allocations
  USING (TRUE) WITH CHECK (TRUE);

-- =============================================================
-- 16. TIME ENTRIES
-- =============================================================
CREATE TABLE IF NOT EXISTS time_entries (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id         UUID REFERENCES tasks(id) ON DELETE SET NULL,
  user_id         UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  hours_logged    NUMERIC(10,2) NOT NULL,
  entry_date      DATE NOT NULL,
  week_start_date DATE NOT NULL,
  description     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_time_entries_updated_at
  BEFORE UPDATE ON time_entries
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE INDEX IF NOT EXISTS idx_time_entries_user_week    ON time_entries(user_id, week_start_date);
CREATE INDEX IF NOT EXISTS idx_time_entries_project      ON time_entries(project_id);
CREATE INDEX IF NOT EXISTS idx_time_entries_task         ON time_entries(task_id);
CREATE INDEX IF NOT EXISTS idx_time_entries_entry_date   ON time_entries(entry_date);

ALTER TABLE time_entries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "time_entries_service_role_all" ON time_entries
  USING (TRUE) WITH CHECK (TRUE);

-- =============================================================
-- 17. CLOCK SESSIONS
-- =============================================================
CREATE TABLE IF NOT EXISTS clock_sessions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  task_id          UUID REFERENCES tasks(id) ON DELETE SET NULL,
  project_id       UUID REFERENCES projects(id) ON DELETE SET NULL,
  start_time       TIMESTAMPTZ NOT NULL,
  end_time         TIMESTAMPTZ,
  duration_minutes INTEGER,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_clock_sessions_user ON clock_sessions(user_id);

ALTER TABLE clock_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "clock_sessions_service_role_all" ON clock_sessions
  USING (TRUE) WITH CHECK (TRUE);

-- =============================================================
-- 18. USER AVAILABILITY
-- =============================================================
CREATE TABLE IF NOT EXISTS user_availability (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  week_start_date DATE NOT NULL,
  available_hours NUMERIC(10,2) NOT NULL DEFAULT 40,
  schedule_data   JSONB,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, week_start_date)
);

CREATE TRIGGER trg_user_availability_updated_at
  BEFORE UPDATE ON user_availability
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE INDEX IF NOT EXISTS idx_user_availability_user_week ON user_availability(user_id, week_start_date);

ALTER TABLE user_availability ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_availability_service_role_all" ON user_availability
  USING (TRUE) WITH CHECK (TRUE);

-- =============================================================
-- 19. WORKFLOW TEMPLATES
-- =============================================================
CREATE TABLE IF NOT EXISTS workflow_templates (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  description TEXT,
  created_by  UUID REFERENCES user_profiles(id) ON DELETE SET NULL,
  is_active   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_workflow_templates_updated_at
  BEFORE UPDATE ON workflow_templates
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE workflow_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "workflow_templates_service_role_all" ON workflow_templates
  USING (TRUE) WITH CHECK (TRUE);

-- =============================================================
-- 20. WORKFLOW NODES
-- =============================================================
CREATE TABLE IF NOT EXISTS workflow_nodes (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_template_id UUID NOT NULL REFERENCES workflow_templates(id) ON DELETE CASCADE,
  label                TEXT NOT NULL,
  node_type            TEXT NOT NULL
                         CHECK (node_type IN ('start','end','approval','form','department','role','conditional','sync')),
  entity_id            UUID,
  config               JSONB,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_workflow_nodes_updated_at
  BEFORE UPDATE ON workflow_nodes
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE INDEX IF NOT EXISTS idx_workflow_nodes_template ON workflow_nodes(workflow_template_id);

ALTER TABLE workflow_nodes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "workflow_nodes_service_role_all" ON workflow_nodes
  USING (TRUE) WITH CHECK (TRUE);

-- =============================================================
-- 21. WORKFLOW CONNECTIONS
-- =============================================================
CREATE TABLE IF NOT EXISTS workflow_connections (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_template_id UUID NOT NULL REFERENCES workflow_templates(id) ON DELETE CASCADE,
  from_node_id         UUID NOT NULL REFERENCES workflow_nodes(id) ON DELETE CASCADE,
  to_node_id           UUID NOT NULL REFERENCES workflow_nodes(id) ON DELETE CASCADE,
  condition            TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workflow_connections_template  ON workflow_connections(workflow_template_id);
CREATE INDEX IF NOT EXISTS idx_workflow_connections_from_node ON workflow_connections(from_node_id);

ALTER TABLE workflow_connections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "workflow_connections_service_role_all" ON workflow_connections
  USING (TRUE) WITH CHECK (TRUE);

-- =============================================================
-- 22. WORKFLOW INSTANCES
-- =============================================================
CREATE TABLE IF NOT EXISTS workflow_instances (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_template_id UUID NOT NULL REFERENCES workflow_templates(id) ON DELETE RESTRICT,
  project_id           UUID REFERENCES projects(id) ON DELETE CASCADE,
  task_id              UUID REFERENCES tasks(id) ON DELETE CASCADE,
  current_node_id      UUID REFERENCES workflow_nodes(id) ON DELETE SET NULL,
  status               TEXT NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active','completed','cancelled')),
  started_snapshot     JSONB,
  completed_at         TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_workflow_instances_updated_at
  BEFORE UPDATE ON workflow_instances
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE INDEX IF NOT EXISTS idx_workflow_instances_project ON workflow_instances(project_id);
CREATE INDEX IF NOT EXISTS idx_workflow_instances_status  ON workflow_instances(status);

ALTER TABLE workflow_instances ENABLE ROW LEVEL SECURITY;

CREATE POLICY "workflow_instances_service_role_all" ON workflow_instances
  USING (TRUE) WITH CHECK (TRUE);

-- =============================================================
-- 23. WORKFLOW HISTORY
-- =============================================================
CREATE TABLE IF NOT EXISTS workflow_history (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_instance_id UUID NOT NULL REFERENCES workflow_instances(id) ON DELETE CASCADE,
  from_node_id         UUID NOT NULL REFERENCES workflow_nodes(id) ON DELETE RESTRICT,
  to_node_id           UUID NOT NULL REFERENCES workflow_nodes(id) ON DELETE RESTRICT,
  transitioned_by      UUID REFERENCES user_profiles(id) ON DELETE SET NULL,
  notes                TEXT,
  transition_type      TEXT NOT NULL DEFAULT 'normal'
                         CHECK (transition_type IN ('normal','skip','rejection')),
  out_of_order         BOOLEAN NOT NULL DEFAULT FALSE,
  form_response_id     UUID,  -- FK added after form_responses
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workflow_history_instance ON workflow_history(workflow_instance_id);
CREATE INDEX IF NOT EXISTS idx_workflow_history_created  ON workflow_history(created_at);

ALTER TABLE workflow_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "workflow_history_service_role_all" ON workflow_history
  USING (TRUE) WITH CHECK (TRUE);

-- =============================================================
-- 24. WORKFLOW ACTIVE STEPS
-- =============================================================
CREATE TABLE IF NOT EXISTS workflow_active_steps (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_instance_id UUID NOT NULL REFERENCES workflow_instances(id) ON DELETE CASCADE,
  node_id              UUID NOT NULL REFERENCES workflow_nodes(id) ON DELETE CASCADE,
  assigned_user_id     UUID REFERENCES user_profiles(id) ON DELETE SET NULL,
  branch_id            TEXT NOT NULL DEFAULT 'main',
  status               TEXT NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active','completed','skipped')),
  completed_at         TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_workflow_active_steps_updated_at
  BEFORE UPDATE ON workflow_active_steps
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE INDEX IF NOT EXISTS idx_workflow_active_steps_instance ON workflow_active_steps(workflow_instance_id);

ALTER TABLE workflow_active_steps ENABLE ROW LEVEL SECURITY;

CREATE POLICY "workflow_active_steps_service_role_all" ON workflow_active_steps
  USING (TRUE) WITH CHECK (TRUE);

-- =============================================================
-- 25. WORKFLOW NODE ASSIGNMENTS
-- =============================================================
CREATE TABLE IF NOT EXISTS workflow_node_assignments (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_node_id UUID NOT NULL REFERENCES workflow_nodes(id) ON DELETE CASCADE,
  assigned_user_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workflow_node_assignments_node ON workflow_node_assignments(workflow_node_id);

ALTER TABLE workflow_node_assignments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "workflow_node_assignments_service_role_all" ON workflow_node_assignments
  USING (TRUE) WITH CHECK (TRUE);

-- =============================================================
-- 26. WORKFLOW APPROVALS
-- =============================================================
CREATE TABLE IF NOT EXISTS workflow_approvals (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_instance_id UUID NOT NULL REFERENCES workflow_instances(id) ON DELETE CASCADE,
  node_id              UUID NOT NULL REFERENCES workflow_nodes(id) ON DELETE CASCADE,
  approver_id          UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  status               TEXT NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','approved','rejected')),
  comments             TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_workflow_approvals_updated_at
  BEFORE UPDATE ON workflow_approvals
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE workflow_approvals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "workflow_approvals_service_role_all" ON workflow_approvals
  USING (TRUE) WITH CHECK (TRUE);

-- =============================================================
-- 27. FORM TEMPLATES
-- =============================================================
CREATE TABLE IF NOT EXISTS form_templates (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  description TEXT,
  fields      JSONB NOT NULL DEFAULT '[]',
  created_by  UUID REFERENCES user_profiles(id) ON DELETE SET NULL,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_form_templates_updated_at
  BEFORE UPDATE ON form_templates
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE form_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "form_templates_service_role_all" ON form_templates
  USING (TRUE) WITH CHECK (TRUE);

-- =============================================================
-- 28. FORM RESPONSES
-- =============================================================
CREATE TABLE IF NOT EXISTS form_responses (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  form_template_id    UUID NOT NULL REFERENCES form_templates(id) ON DELETE RESTRICT,
  workflow_history_id UUID REFERENCES workflow_history(id) ON DELETE SET NULL,
  submitted_by        UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  response_data       JSONB NOT NULL DEFAULT '{}',
  submitted_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_form_responses_updated_at
  BEFORE UPDATE ON form_responses
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE INDEX IF NOT EXISTS idx_form_responses_template ON form_responses(form_template_id);
CREATE INDEX IF NOT EXISTS idx_form_responses_history  ON form_responses(workflow_history_id);

ALTER TABLE form_responses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "form_responses_service_role_all" ON form_responses
  USING (TRUE) WITH CHECK (TRUE);

-- Now add the deferred FK from workflow_history → form_responses
ALTER TABLE workflow_history
  ADD CONSTRAINT fk_workflow_history_form_response
  FOREIGN KEY (form_response_id) REFERENCES form_responses(id) ON DELETE SET NULL;

-- =============================================================
-- 29. CLIENT PORTAL INVITATIONS
-- =============================================================
CREATE TABLE IF NOT EXISTS client_portal_invitations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  token       TEXT NOT NULL UNIQUE,
  status      TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','accepted','rejected','expired','cancelled')),
  invited_by  UUID REFERENCES user_profiles(id) ON DELETE SET NULL,
  invited_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ,
  accepted_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_client_portal_invitations_updated_at
  BEFORE UPDATE ON client_portal_invitations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE INDEX IF NOT EXISTS idx_client_portal_invitations_account ON client_portal_invitations(account_id);
CREATE INDEX IF NOT EXISTS idx_client_portal_invitations_token   ON client_portal_invitations(token);

ALTER TABLE client_portal_invitations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "client_portal_invitations_service_role_all" ON client_portal_invitations
  USING (TRUE) WITH CHECK (TRUE);

-- =============================================================
-- 30. CLIENT FEEDBACK
-- =============================================================
CREATE TABLE IF NOT EXISTS client_feedback (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id              UUID REFERENCES projects(id) ON DELETE CASCADE,
  client_user_id          UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  satisfaction_score      INTEGER CHECK (satisfaction_score BETWEEN 1 AND 10),
  what_went_well          TEXT,
  what_needs_improvement  TEXT,
  performance_metrics     JSONB,
  workflow_history_id     UUID REFERENCES workflow_history(id) ON DELETE SET NULL,
  visibility              TEXT NOT NULL DEFAULT 'private'
                            CHECK (visibility IN ('private','internal','public')),
  submitted_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_client_feedback_project ON client_feedback(project_id);

ALTER TABLE client_feedback ENABLE ROW LEVEL SECURITY;

CREATE POLICY "client_feedback_service_role_all" ON client_feedback
  USING (TRUE) WITH CHECK (TRUE);

-- =============================================================
-- 31. SETUP TOKENS  (one-time superadmin setup)
-- =============================================================
CREATE TABLE IF NOT EXISTS setup_tokens (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token      TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  used_by    UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE setup_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "setup_tokens_service_role_all" ON setup_tokens
  USING (TRUE) WITH CHECK (TRUE);

-- =============================================================
-- 32. ONBOARDING STATE
-- =============================================================
CREATE TABLE IF NOT EXISTS onboarding_state (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL UNIQUE REFERENCES user_profiles(id) ON DELETE CASCADE,
  current_step     TEXT NOT NULL DEFAULT 'welcome',
  completed_steps  TEXT[] NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_onboarding_state_updated_at
  BEFORE UPDATE ON onboarding_state
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE onboarding_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "onboarding_state_service_role_all" ON onboarding_state
  USING (TRUE) WITH CHECK (TRUE);

-- =============================================================
-- 33. USER INVITATIONS  (internal team invitations)
-- =============================================================
CREATE TABLE IF NOT EXISTS user_invitations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email       TEXT NOT NULL,
  invited_by  UUID REFERENCES user_profiles(id) ON DELETE SET NULL,
  token       TEXT NOT NULL UNIQUE,
  status      TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','accepted','rejected')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_user_invitations_updated_at
  BEFORE UPDATE ON user_invitations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE INDEX IF NOT EXISTS idx_user_invitations_token ON user_invitations(token);

ALTER TABLE user_invitations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_invitations_service_role_all" ON user_invitations
  USING (TRUE) WITH CHECK (TRUE);

-- =============================================================
-- 34. PENDING USER APPROVALS
-- =============================================================
CREATE TABLE IF NOT EXISTS pending_user_approvals (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  status      TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','approved','rejected')),
  reviewed_by UUID REFERENCES user_profiles(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_pending_user_approvals_updated_at
  BEFORE UPDATE ON pending_user_approvals
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE pending_user_approvals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "pending_user_approvals_service_role_all" ON pending_user_approvals
  USING (TRUE) WITH CHECK (TRUE);

-- =============================================================
-- 35. USER DASHBOARD PREFERENCES
-- =============================================================
CREATE TABLE IF NOT EXISTS user_dashboard_preferences (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL UNIQUE REFERENCES user_profiles(id) ON DELETE CASCADE,
  widget_config JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_user_dashboard_preferences_updated_at
  BEFORE UPDATE ON user_dashboard_preferences
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE user_dashboard_preferences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_dashboard_preferences_service_role_all" ON user_dashboard_preferences
  USING (TRUE) WITH CHECK (TRUE);

-- =============================================================
-- 36. NEWSLETTERS
-- =============================================================
CREATE TABLE IF NOT EXISTS newsletters (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title        TEXT NOT NULL,
  content      TEXT NOT NULL,
  is_published BOOLEAN NOT NULL DEFAULT FALSE,
  published_at TIMESTAMPTZ,
  created_by   UUID REFERENCES user_profiles(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_newsletters_updated_at
  BEFORE UPDATE ON newsletters
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE INDEX IF NOT EXISTS idx_newsletters_published ON newsletters(is_published, published_at DESC);

ALTER TABLE newsletters ENABLE ROW LEVEL SECURITY;

CREATE POLICY "newsletters_service_role_all" ON newsletters
  USING (TRUE) WITH CHECK (TRUE);

-- =============================================================
-- 37. ESCROWS  (milestone escrow — used by escrow-service)
-- =============================================================
CREATE TABLE IF NOT EXISTS escrows (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id             UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  client_id              UUID NOT NULL REFERENCES user_profiles(id) ON DELETE RESTRICT,
  contractor_id          UUID NOT NULL REFERENCES user_profiles(id) ON DELETE RESTRICT,
  total_milestones       INT NOT NULL CHECK (total_milestones > 0),
  milestones_approved    INT NOT NULL DEFAULT 0 CHECK (milestones_approved >= 0),
  milestones_claimed     INT NOT NULL DEFAULT 0 CHECK (milestones_claimed >= 0),
  amount_per_milestone   BIGINT NOT NULL CHECK (amount_per_milestone > 0),
  status                 TEXT NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending', 'active', 'completed', 'cancelled')),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (milestones_approved <= total_milestones),
  CHECK (milestones_claimed <= milestones_approved)
);

CREATE INDEX IF NOT EXISTS idx_escrows_project_id ON escrows(project_id);
CREATE INDEX IF NOT EXISTS idx_escrows_client_id ON escrows(client_id);
CREATE INDEX IF NOT EXISTS idx_escrows_contractor_id ON escrows(contractor_id);
CREATE INDEX IF NOT EXISTS idx_escrows_status ON escrows(status);

ALTER TABLE escrows ENABLE ROW LEVEL SECURITY;

CREATE POLICY "escrows_service_role_all" ON escrows
  USING (TRUE) WITH CHECK (TRUE);

-- =============================================================
-- 38. ESTIMATES  (account-scoped quotations)
--
-- MONEY MODEL
--   Every amount is an integer count of the currency's minor unit
--   (e.g. cents). No NUMERIC/FLOAT money columns, no float math.
--   currency + *_minor always travel together: 12345 + 'USD' == 123.45 USD.
--
--   Line amounts are GENERATED by PostgreSQL from an exact NUMERIC
--   quantity multiplied by an integer unit price, so a stored line
--   amount can never drift from quantity * unit_price_minor.
--
-- TENANCY
--   account_id is NOT NULL on every row. The composite FK
--   (project_id, account_id) -> projects(id, account_id) makes a
--   cross-account project link impossible at the storage layer, and
--   also blocks re-parenting a project into another account while an
--   estimate still references it (ON UPDATE is NO ACTION).
--
-- LIFECYCLE
--   draft -> sent -> accepted | rejected. No hard delete: there is no
--   deleted_at and no DELETE path; rejected estimates are kept.
--   Requires PostgreSQL 15+ (Supabase default) for
--   "ON DELETE SET NULL (column_list)".
-- =============================================================

-- Reference target for the composite FK below. id is already the primary
-- key, so (id, account_id) is unique by construction; a unique index is
-- all a foreign key needs to reference the pair.
CREATE UNIQUE INDEX IF NOT EXISTS uq_projects_id_account
  ON projects(id, account_id);

CREATE TABLE IF NOT EXISTS estimates (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  project_id      UUID,
  estimate_number TEXT NOT NULL,
  title           TEXT NOT NULL,
  description     TEXT,
  status          TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'sent', 'accepted', 'rejected')),
  currency        TEXT NOT NULL DEFAULT 'USD'
                    CHECK (currency ~ '^[A-Z]{3}$'),
  subtotal_minor  BIGINT NOT NULL DEFAULT 0
                    CHECK (subtotal_minor >= 0),
  tax_minor       BIGINT NOT NULL DEFAULT 0
                    CHECK (tax_minor >= 0),
  total_minor     BIGINT NOT NULL DEFAULT 0
                    CHECK (total_minor >= 0),
  created_by      UUID REFERENCES user_profiles(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Human-readable reference: never blank, bounded length.
  CONSTRAINT estimates_number_not_blank
    CHECK (btrim(estimate_number) <> '' AND length(estimate_number) <= 64),
  CONSTRAINT estimates_title_not_blank
    CHECK (btrim(title) <> '' AND length(title) <= 200),
  CONSTRAINT estimates_description_length
    CHECK (description IS NULL OR length(description) <= 5000),

  -- Totals must always balance. Reconciliation against the line items
  -- themselves is an application-level invariant (a row constraint cannot
  -- aggregate children).
  CONSTRAINT estimates_totals_balance
    CHECK (total_minor = subtotal_minor + tax_minor),

  -- Optional project link, tenant-safe: the project must live in the same
  -- account as the estimate. NULL project_id skips the check entirely.
  -- Deleting a project clears the link but keeps the estimate and its account.
  CONSTRAINT estimates_project_same_account
    FOREIGN KEY (project_id, account_id)
    REFERENCES projects(id, account_id)
    ON DELETE SET NULL (project_id)
);

-- Estimate numbers are unique PER ACCOUNT (not globally) and compared
-- case-insensitively, so 'EST-001' and 'est-001' cannot coexist in one account.
CREATE UNIQUE INDEX IF NOT EXISTS uq_estimates_account_number
  ON estimates(account_id, lower(estimate_number));

CREATE INDEX IF NOT EXISTS idx_estimates_account_status_created
  ON estimates(account_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_estimates_project_id ON estimates(project_id);
CREATE INDEX IF NOT EXISTS idx_estimates_created_by ON estimates(created_by);

DROP TRIGGER IF EXISTS trg_estimates_updated_at ON estimates;
CREATE TRIGGER trg_estimates_updated_at
  BEFORE UPDATE ON estimates
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- =============================================================
-- 39. ESTIMATE LINE ITEMS
--
-- quantity is NUMERIC(12,3), NOT an integer: service work is quoted in
-- fractional units (1.5 hours, 0.25 day). Exact decimal, never float.
-- amount_minor is a stored generated column: always
--   round(quantity * unit_price_minor)  (PostgreSQL numeric rounding,
--   halves away from zero), cast to BIGINT.
-- =============================================================
CREATE TABLE IF NOT EXISTS estimate_line_items (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  estimate_id      UUID NOT NULL REFERENCES estimates(id) ON DELETE CASCADE,
  description      TEXT NOT NULL,
  quantity         NUMERIC(12,3) NOT NULL,
  unit_price_minor BIGINT NOT NULL,
  amount_minor     BIGINT GENERATED ALWAYS AS
                     ((round(quantity * unit_price_minor))::bigint) STORED,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT estimate_line_items_description_not_blank
    CHECK (btrim(description) <> '' AND length(description) <= 500),
  CONSTRAINT estimate_line_items_quantity_positive
    CHECK (quantity > 0 AND quantity <= 1000000),
  CONSTRAINT estimate_line_items_unit_price_non_negative
    CHECK (unit_price_minor >= 0),
  CONSTRAINT estimate_line_items_sort_order_non_negative
    CHECK (sort_order >= 0)
);

CREATE INDEX IF NOT EXISTS idx_estimate_line_items_estimate
  ON estimate_line_items(estimate_id, sort_order);

-- =============================================================
-- ESTIMATES: RLS
--
-- Both tables enable RLS but intentionally declare NO policy. Financial
-- rows must not be readable by the publishable/anon key that the browser
-- Supabase client carries; every access goes through server-side code
-- using the service-role client (which bypasses RLS). This is deny-by-
-- default for anon/authenticated, and deliberately stricter than the
-- blanket USING (TRUE) policies used by non-financial tables.
-- =============================================================
ALTER TABLE estimates ENABLE ROW LEVEL SECURITY;
ALTER TABLE estimate_line_items ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE estimates IS
  'Account-scoped quotations. All *_minor columns are integer minor currency units.';
COMMENT ON COLUMN estimates.account_id IS
  'Tenant owner. Never null; composite FK with project_id prevents cross-account links.';
COMMENT ON COLUMN estimates.estimate_number IS
  'Human-readable reference, unique per account (case-insensitive).';
COMMENT ON COLUMN estimates.subtotal_minor IS 'Sum of line amount_minor, in minor units.';
COMMENT ON COLUMN estimates.tax_minor IS 'Tax in minor units; total_minor = subtotal_minor + tax_minor.';
COMMENT ON COLUMN estimates.total_minor IS 'Final total in minor units (never floating point).';
COMMENT ON TABLE estimate_line_items IS
  'Estimate lines. amount_minor is generated from quantity * unit_price_minor.';
COMMENT ON COLUMN estimate_line_items.quantity IS
  'Exact decimal quantity (up to 3 dp) so fractional hours/days are supported.';
COMMENT ON COLUMN estimate_line_items.amount_minor IS
  'Generated: round(quantity * unit_price_minor) in minor units.';

-- END 38/39. ESTIMATES

-- =============================================================
-- 40. IDEMPOTENCY KEYS (idempotent estimate creation)
--
-- The unique constraint on (user_id, account_id, idempotency_key) is what
-- arbitrates concurrent retries. RLS is enabled with NO policies: only
-- SECURITY DEFINER functions and service_role may touch these rows.
-- Retention: 30 days, swept by public.purge_expired_idempotency_keys().
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

CREATE INDEX IF NOT EXISTS idx_idempotency_keys_created_at
  ON public.idempotency_keys (created_at);

ALTER TABLE public.idempotency_keys ENABLE ROW LEVEL SECURITY;

GRANT ALL ON public.idempotency_keys TO service_role;

COMMENT ON TABLE public.idempotency_keys IS
  'Processed idempotent requests. Unique per (user, account, key); the unique constraint arbitrates concurrent retries.';
COMMENT ON COLUMN public.idempotency_keys.request_hash IS
  'SHA-256 hex of the canonical (normalised) request payload. Same key + different hash = 409.';
COMMENT ON COLUMN public.idempotency_keys.response_body IS
  'Stored response envelope (estimate + line items) replayed verbatim for duplicates.';
COMMENT ON COLUMN public.idempotency_keys.estimate_id IS
  'Estimate created by the original request; traceability only.';

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

-- =============================================================
-- 41. IDEMPOTENT ESTIMATE CREATION (single transaction)
--
-- Claims the key, writes estimate + line items, stores the replay
-- envelope. Identity comes from auth.uid(); membership is re-checked here
-- because the function is SECURITY DEFINER.
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

  INSERT INTO public.idempotency_keys (user_id, account_id, idempotency_key, request_hash)
  VALUES (v_user_id, p_account_id, p_idempotency_key, p_request_hash)
  ON CONFLICT (user_id, account_id, idempotency_key) DO NOTHING
  RETURNING id INTO v_claimed_id;

  IF v_claimed_id IS NULL THEN
    SELECT *
    INTO v_existing
    FROM public.idempotency_keys ik
    WHERE ik.user_id = v_user_id
      AND ik.account_id = p_account_id
      AND ik.idempotency_key = p_idempotency_key;

    IF v_existing.id IS NULL THEN
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

  INSERT INTO public.estimates (
    account_id, project_id, estimate_number, title, description, status,
    currency, subtotal_minor, tax_minor, total_minor, created_by
  )
  VALUES (
    p_account_id, p_project_id, p_estimate_number, p_title, p_description, 'draft',
    p_currency, p_subtotal_minor, p_tax_minor, p_total_minor, v_user_id
  )
  RETURNING * INTO v_estimate;

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

-- =============================================================
-- DEFERRED FKs (tables that reference each other)
-- =============================================================

-- project_issues → workflow_history (workflow_history was created after project_issues)
ALTER TABLE project_issues
  ADD CONSTRAINT fk_project_issues_workflow_history
  FOREIGN KEY (workflow_history_id) REFERENCES workflow_history(id) ON DELETE SET NULL;

-- =============================================================
-- AUTO-CREATE USER PROFILE ON SIGNUP
-- Supabase calls this trigger when a new auth.users row is inserted
-- =============================================================
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.user_profiles (id, email, name)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'name', NEW.raw_user_meta_data->>'full_name', split_part(NEW.email, '@', 1))
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- =============================================================
-- SEED: SYSTEM ROLES
-- These are the built-in roles that cannot be edited or deleted.
-- =============================================================
INSERT INTO roles (id, name, description, is_system_role, hierarchy_level, permissions)
VALUES
  (
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'Superadmin',
    'Full system access. Bypasses all permission checks.',
    TRUE, 100,
    '{}'::jsonb
  ),
  (
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    'Client',
    'External client user. Access limited to their account projects.',
    TRUE, 0,
    '{"view_projects": true}'::jsonb
  )
ON CONFLICT (id) DO NOTHING;
