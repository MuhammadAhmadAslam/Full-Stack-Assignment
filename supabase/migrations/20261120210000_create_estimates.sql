-- =============================================================
-- Migration: 20261120210000_create_estimates
--
-- Adds account-scoped quotations: estimates + estimate_line_items,
-- plus the unique index on projects that the composite tenancy FK
-- needs as its reference target.
--
-- Additive only:
--   * no existing table is dropped, recreated or renamed;
--   * no column is altered or removed;
--   * no row is inserted, updated or deleted;
--   * the single touch on an existing table is CREATE UNIQUE INDEX on
--     projects(id, account_id), which cannot fail because id is the
--     primary key and account_id is NOT NULL.
--
-- Safe to re-run: every object is guarded (IF NOT EXISTS) and the
-- updated_at trigger is dropped before being recreated. Applying this
-- after supabase/schema.sql — which already contains the same DDL in
-- sections 38–39 — is a no-op.
--
-- Requires PostgreSQL 15+ (Supabase default) for
-- "ON DELETE SET NULL (column_list)".
--
-- Manual rollback (not part of the migration):
--   DROP TABLE IF EXISTS estimate_line_items;
--   DROP TABLE IF EXISTS estimates;
--   DROP INDEX IF EXISTS uq_projects_id_account;
-- =============================================================

-- =============================================================
-- 1. REFERENCE TARGET FOR THE TENANCY FK
-- =============================================================
CREATE UNIQUE INDEX IF NOT EXISTS uq_projects_id_account
  ON projects(id, account_id);

-- =============================================================
-- 2. ESTIMATES
--
-- MONEY MODEL
--   Every amount is an integer count of the currency's minor unit
--   (e.g. cents). No NUMERIC/FLOAT money columns, no float math.
--   currency + *_minor always travel together:
--   12345 + 'USD' == 123.45 USD.
--
-- TENANCY
--   account_id is NOT NULL on every row. The composite FK
--   (project_id, account_id) -> projects(id, account_id) makes a
--   cross-account project link impossible at the storage layer, and
--   blocks re-parenting a project into another account while an
--   estimate references it (ON UPDATE defaults to NO ACTION).
--
-- LIFECYCLE
--   draft -> sent -> accepted | rejected. No hard delete: no
--   deleted_at, no DELETE path; rejected estimates are kept.
-- =============================================================
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
  -- themselves is an application-level invariant (a row constraint
  -- cannot aggregate children).
  CONSTRAINT estimates_totals_balance
    CHECK (total_minor = subtotal_minor + tax_minor),

  -- Optional project link, tenant-safe: the project must live in the
  -- same account as the estimate. NULL project_id skips the check
  -- (MATCH SIMPLE). Deleting a project clears the link but keeps the
  -- estimate and its account.
  CONSTRAINT estimates_project_same_account
    FOREIGN KEY (project_id, account_id)
    REFERENCES projects(id, account_id)
    ON DELETE SET NULL (project_id)
);

-- =============================================================
-- 3. ESTIMATE LINE ITEMS
--
-- quantity is NUMERIC(12,3), NOT an integer: service work is quoted in
-- fractional units (1.5 hours, 0.25 day). Exact decimal, never float.
-- amount_minor is a stored generated column: always
--   round(quantity * unit_price_minor)
-- computed by PostgreSQL in exact numeric, halves away from zero,
-- cast to BIGINT.
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

-- =============================================================
-- 4. UNIQUE CONSTRAINTS
-- =============================================================

-- Estimate numbers are unique PER ACCOUNT (not globally) and compared
-- case-insensitively: 'EST-001' and 'est-001' cannot coexist in one
-- account, while two tenants may each own 'EST-001'.
CREATE UNIQUE INDEX IF NOT EXISTS uq_estimates_account_number
  ON estimates(account_id, lower(estimate_number));

-- =============================================================
-- 5. INDEXES
-- =============================================================
CREATE INDEX IF NOT EXISTS idx_estimates_account_status_created
  ON estimates(account_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_estimates_project_id ON estimates(project_id);
CREATE INDEX IF NOT EXISTS idx_estimates_created_by ON estimates(created_by);

CREATE INDEX IF NOT EXISTS idx_estimate_line_items_estimate
  ON estimate_line_items(estimate_id, sort_order);

-- =============================================================
-- 6. TIMESTAMPS
-- Reuses the shared trigger function defined at the top of schema.sql.
-- =============================================================
DROP TRIGGER IF EXISTS trg_estimates_updated_at ON estimates;
CREATE TRIGGER trg_estimates_updated_at
  BEFORE UPDATE ON estimates
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- =============================================================
-- 7. RLS
--
-- Both tables enable RLS but intentionally declare NO policy.
-- Financial rows must not be readable with the publishable/anon key
-- carried by the browser Supabase client; server-side code uses the
-- service-role client, which bypasses RLS. Deny-by-default for
-- anon/authenticated, deliberately stricter than the blanket
-- USING (TRUE) policies on non-financial tables.
-- =============================================================
ALTER TABLE estimates ENABLE ROW LEVEL SECURITY;
ALTER TABLE estimate_line_items ENABLE ROW LEVEL SECURITY;

-- =============================================================
-- 8. DOCUMENTATION
-- =============================================================
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
