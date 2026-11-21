# Kontrora — Estimates (Revenue & Billing)

A multi-tenant professional services automation (PSA) platform. This fork ships one revenue slice — **account-scoped estimates** — end to end: schema, tenancy, RBAC, money-correct APIs, and UI.

**Stack:** Next.js 16 (App Router), React 19, Supabase / PostgreSQL.

---

## Contents

1. [Project overview](#1-project-overview)
2. [Architecture / design decisions](#2-architecture--design-decisions)
3. [Setup instructions](#3-setup-instructions)
4. [Environment variables](#4-environment-variables)
5. [Database migrations](#5-database-migrations)
6. [Running tests](#6-running-tests)
7. [Security & tenancy](#7-security--tenancy)
8. [RBAC / permission design](#8-rbac--permission-design)
9. [Known limitations & future improvements](#9-known-limitations--future-improvements)

---

## 1. Project overview

Kontrora already had accounts, projects, tasks, workflows, and roles. Existing tables and routes were left in place except where estimates needed to plug in.

The estimates slice lets staff author a **draft** quote against an account (optional project), send it, then accept or reject it. Totals are computed on the server. There is no delete path: estimates are financial records.

| Layer | What shipped |
|---|---|
| Schema | `estimates` + `estimate_line_items` with tenant-safe constraints |
| Security | RLS, membership helpers, six financial permissions |
| Idempotency | `idempotency_keys` + `create_estimate_idempotent(...)` |
| Domain | `lib/estimate-service.ts` — create / read / update / lifecycle |
| Money | `lib/estimate-money.ts` — integer / `BigInt` arithmetic, no floats |
| Validation | Zod schemas in `lib/validation-schemas.ts` |
| API | List, create, get, patch draft, send, accept, reject |
| UI | `/accounts/<accountId>/estimates` — list, create, edit draft, detail |

This README only describes what is in the repository.

---

## 2. Architecture / design decisions

### Schema

`public.estimates`:

- `account_id` — tenant owner, `NOT NULL`. A client-supplied account id is a claim to verify, never proof.
- `project_id` — optional. Composite FK `(project_id, account_id) → projects(id, account_id)` with `ON DELETE SET NULL (project_id)`. A project from another account cannot be attached; deleting a project detaches it instead of deleting the estimate.
- `estimate_number` — unique **per account, case-insensitive**: `(account_id, lower(estimate_number))`.
- `status` in `draft | sent | accepted | rejected`.
- `subtotal_minor`, `tax_minor`, `total_minor` — `BIGINT`, with `CHECK (total_minor = subtotal_minor + tax_minor)`.

`estimate_line_items`:

- Child of `estimates` with `ON DELETE CASCADE` (referential integrity only — there is **no delete API**).
- `quantity NUMERIC(12,3)` (fractional hours/days). `unit_price_minor BIGINT`.
- `amount_minor` is `GENERATED ALWAYS AS (round(quantity * unit_price_minor)::bigint) STORED`, so the stored amount cannot disagree with quantity × price.

### Money

- All money is integer **minor units**. No float money columns, no float arithmetic in application code.
- Quantities are parsed from **decimal strings** into scaled integers and multiplied with `BigInt`, then rounded half away from zero (same rule as PostgreSQL `round(numeric)`).
- Float artifacts such as `"0.30000000000000004"` are **rejected**, not silently rounded.
- Tax is integer **basis points** (825 = 8.25%) applied to the integer subtotal.
- Create/update schemas are `.strict()`: the client cannot submit `subtotal_minor` / `total_minor`.

### API

| Method & path | Purpose |
|---|---|
| `GET /api/estimates` | Account-scoped list (`account_id` required; filters, sort, `limit` ≤ 100) |
| `POST /api/estimates` | Create draft. **`Idempotency-Key` required**. 201 created / 200 replay |
| `GET /api/estimates/[estimateId]` | Detail + line items. Foreign ids return 404 |
| `PATCH /api/estimates/[estimateId]` | Edit **draft** only (409 otherwise); totals recalculated |
| `POST …/send` | `draft` → `sent` |
| `POST …/accept` / `POST …/reject` | `sent` → terminal state |

JSON shape: `{ success, … }` or `{ error, code?, details? }`. Status codes: 400 validation, 401 no session, 403 member without the permission, 404 missing **or** another tenant’s id, 409 invalid transition / concurrent change / idempotency conflict, 500 infrastructure only.

Responses are built from explicit field allowlists (`serializeEstimate`), never by spreading a database row.

### Idempotency

- Scope: `UNIQUE (user_id, account_id, idempotency_key)`.
- Fingerprint is SHA-256 of the **normalised** payload (trimmed fields, upper-cased currency, canonical quantity strings, server-computed totals), so `3` and `"3.000"` replay instead of conflicting.
- `create_estimate_idempotent(...)` is one `SECURITY DEFINER` transaction: claim key, insert estimate, insert lines, store the replay envelope. Failure rolls the key back.
- Same key + different fingerprint → `409`. Same key + same fingerprint → `200` with the original envelope.
- Identity inside the function is `auth.uid()`. Retention is 30 days via `purge_expired_idempotency_keys(...)` (`service_role` only). The app does not schedule that purge.

### Lifecycle

```
draft ──send──▶ sent ──accept──▶ accepted
                    └──reject──▶ rejected
```

`accepted` and `rejected` are terminal. Line items are editable only in `draft`. Transitions use compare-and-set (`UPDATE … WHERE status = <expected>`). A zero-row update is returned as **409**, never retried silently. There is no delete endpoint.

---

## 3. Setup instructions

**Requires Node.js ≥ 20.9** (`next@16.3.1` engines).

```bash
npm install
cp .env.local.template .env.local
```

Fill in the three required Supabase values (see [§4](#4-environment-variables)). Then apply the database ([§5](#5-database-migrations)) and seed demo users:

```bash
npm run seed:users
npm run dev          # http://localhost:3000
```

After seed, `/login` shows **role cards** (no email/password form). Click **Account Manager** to sign in. All seeded users use password `Test1234!` (the card submits it for you).

| Card | Email | Estimates access |
|---|---|---|
| Account Manager | `manager@test.local` | All six permissions — use this for estimates QA |
| Project Manager | `pm@test.local` | view, create, update, send (no accept/reject) |
| Executive Director | `exec@test.local` | view only |
| Admin / Designer / Developer / Contributor / Client | `admin@` / `designer@` / `dev@` / `contributor@` / `client@test.local` | none |
| SuperAdmin | `superadmin@test.local` | system-level; still must be a member to touch an account’s estimates |

Then: **Accounts → Meridian Financial Group → Estimates** (`/accounts/<accountId>/estimates`).

If login redirects to `/onboarding`, seed did not land on the same project as `.env.local`. Re-run `npm run seed:users`.

---

## 4. Environment variables

Copy `.env.local.template` → `.env.local`. **Names only below — never commit real keys.** Do not prefix the service-role key with `NEXT_PUBLIC_`.

### Required

| Variable | Used for |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL (browser + server) |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY` | Publishable / anon key (RLS-bound) |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only admin client |

### Optional (not used by the estimates slice)

| Variable | Used for |
|---|---|
| `NEXT_PUBLIC_APP_URL` | App origin (default `http://localhost:3000`) |
| `NEXT_PUBLIC_API_URL` | Legacy API origin |
| `LOG_LEVEL` | Server log verbosity |
| `NODE_ENV` | `development` / `production` |
| `NEXT_PUBLIC_DEMO_MODE` | Extra demo guards; role-card login works without it after seed |
| `SETUP_SECRET` | First-run setup gate |
| `CRON_SECRET` | Cron routes |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Email |
| `RESEND_API_KEY` | Alternate email provider |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `ENABLE_RATE_LIMIT` | Rate limiting |
| `GO_ESCROW_SERVICE_URL` | Escrow sidecar (not part of estimates) |

`SUPABASE_SERVICE_ROLE_KEY` is read only in `lib/supabase-server.ts`. Estimate APIs run with the **user session client**, so RLS still applies.

---

## 5. Database migrations

PostgreSQL 15+ (composite FK / `ON DELETE SET NULL (column)`).

### Fresh project (recommended)

1. Open Supabase Dashboard → **SQL Editor → New query**.
2. Paste the full contents of `supabase/setup-all.sql` and **Run**.
3. In a second query:

```sql
NOTIFY pgrst, 'reload schema';
```

`setup-all.sql` is schema + estimates tables + RLS + financial permissions + idempotency function + role seeds, in dependency order.

Confirm tables exist:

```sql
select count(*) as public_tables
from information_schema.tables
where table_schema = 'public';
```

That count should not be `0`. Then `npm run seed:users`.

### Existing database (ordered migrations)

If the base schema is already applied, run these files in order:

```text
supabase/migrations/20261120210000_create_estimates.sql
supabase/migrations/20261120220000_add_estimates_rls.sql
supabase/migrations/20261120230000_grant_financial_permissions.sql
supabase/migrations/20261121000000_create_idempotency_keys.sql
supabase/migrations/20261121010000_create_estimate_idempotent.sql
supabase/migrations/20261121020000_align_status_checks.sql
```

`seed-roles.sql` already includes the financial keys; the grant migration is additive and safe to re-run. `align_status_checks.sql` fixes account/project/task status checks so seed can insert `active` accounts.

There is no `supabase/config.toml` and no local Supabase CLI workflow in this repo. Apply SQL in the Dashboard (or `psql`) against the same project as `.env.local`.

---

## 6. Running tests

```bash
npm test            # vitest run
```

Twelve files under `__tests__/`, **197 tests**. They exercise money, Zod payloads, membership vs permission, the domain service, idempotency, and every estimates route handler. Supabase is the only mocked dependency. **This is not a live-database or HTTP E2E suite.**

| File | Covers |
|---|---|
| `estimate-money.test.ts` | Parsing, rounding, tax bps, overflow |
| `money-input.test.ts` | Form strings → minor units / bps |
| `estimate-validation.test.ts` | Zod rules; client totals rejected |
| `financial-access.test.ts` | Membership first; overrides cannot bypass tenancy |
| `estimate-service.test.ts` | Create/update/transitions, draft-only edits, no delete API |
| `idempotency.test.ts` | Keys, fingerprints, concurrent duplicates |
| `estimate-list.test.ts` | Filters, pagination, tenancy |
| `estimate-post.test.ts` | Create route: auth, missing key, conflict |
| `estimate-detail.test.ts` | 404 safety, allowlisted fields |
| `estimate-update-route.test.ts` | PATCH draft-only |
| `estimate-lifecycle.test.ts` | send / accept / reject, terminal states |
| `backend-acceptance.test.ts` | Acceptance table in one place |

Other commands:

```bash
npm run lint
npm run build
npx tsc --noEmit
```

`next.config.ts` sets `typescript.ignoreBuildErrors: true`, so `npm run build` does not fail on existing type errors in legacy pages (`app/projects/page.tsx`, `app/setup/page.tsx`, and related). Estimates files (`lib/estimate-*`, `app/api/estimates/**`, `components/estimates/**`) are not in that set.

There are **no** integration tests, **no** automated RLS tests against a live database, and **no** Playwright coverage of the estimates UI.

---

## 7. Security & tenancy

### Account boundary

Every estimates query is scoped to an `account_id` that is either stored on the row or taken from a validated list/create request. Membership is checked against **that** account.

### Authentication

API routes use a cookie-bound Supabase client (`createApiSupabaseClient`) and `getUserProfileFromRequest`. No profile → **401**. Server pages use `getCurrentUserProfileServer()` + `createServerSupabase()`.

### RLS

Migration `20261120220000_add_estimates_rls.sql` (also in `setup-all.sql`):

- `estimates` and `estimate_line_items`: RLS on; **SELECT / INSERT / UPDATE** for `authenticated`, gated by `public.user_has_account_access(account_id)`. Line items inherit the parent estimate’s account. **No DELETE policy.**
- Helpers are `SECURITY DEFINER`, `STABLE`, `SET search_path = ''`, schema-qualified. Membership = account manager **or** active `account_members` (`removed_at IS NULL`) **or** superadmin.
- `idempotency_keys`: RLS on, **no policies** — only the definer function and `service_role`.

`schema.sql` alone enables RLS on the estimates tables **without** policies (deny-all). Apply the RLS migration or `setup-all.sql`.

### Cross-tenant behaviour

- List of an account you do not belong to → **403**.
- Get / patch / lifecycle on another tenant’s id → **404** with the same body as a missing id (`{ error: 'Estimate not found' }`).
- Foreign `project_id` → **400** in the service, plus the composite FK at the database.
- Idempotency rows cannot be replayed across users or accounts.

### Service-role key

Never `NEXT_PUBLIC_*`. Never imported into a client component. Never returned in a response. Not present in the repository.

### Project ownership

Checked in the service before write, and again by `estimates_project_same_account`.

---

## 8. RBAC / permission design

Estimates add six keys to the existing flat snake_case permission map (`Financial` category). There is **no** `view_all_estimates` override.

| Permission | Meaning |
|---|---|
| `view_estimates` | Read estimates and line items |
| `create_estimates` | Create a draft |
| `update_estimates` | Edit a draft |
| `send_estimates` | `draft` → `sent` |
| `accept_estimates` | Commercial accept |
| `reject_estimates` | Commercial reject |

`lib/financial-access.ts` is the only authorization entry point for this slice:

1. **Active membership first** (account manager, or `account_members` with `removed_at IS NULL`). Project/task assignment does **not** count.
2. Then the financial permission, evaluated **without** account context.

So `view_all_accounts` / `manage_all_projects` cannot open estimates on an account the user does not belong to. Superadmin is handled in that same module and still requires membership for financial rows.

Role defaults (`seed-roles.sql` / `20261120230000`):

| Role | Estimates permissions |
|---|---|
| Account Manager | all six |
| Project Manager | view, create, update, send |
| Executive Director | view |
| Admin, Contributor, Senior Designer, Senior Developer, Client | none |

Custom roles are not granted these keys; missing key = denied. UI actions (New estimate, Edit draft, Send, Accept, Reject) are gated with the same map (`ESTIMATE_PERMISSIONS`).

---

## 9. Known limitations & future improvements

### Deliberately not built

- No payments, invoicing, PDF export, or email. `send` is a **status change**, not delivery to a customer.
- No estimate status history / audit table. Transitions update `status` + `updated_at` only.
- No delete, soft-delete, or archive API.
- Estimate numbers are generated in the browser (`EST-<base36 time>`); a collision is a 409, not an auto-retry.
- Tax **rate** is not stored — only `tax_minor`. Re-editing a taxed draft requires re-entering a rate or keeping the previous amount.
- Single flat tax; no per-line tax, withholding, or FX.
- Draft header edits are last-write-wins (only status uses compare-and-set).
- List pagination is offset-based (max 100).
- Idempotency purge exists as a function but is not scheduled.
- No rate limiting on estimates endpoints.

### Test / ops gaps

- No live Postgres integration or RLS test suite in CI.
- No Playwright E2E for the estimates UI.
- Legacy API routes still call a missing `getUserFromRequest` export; estimates routes do not use that path.
- Several existing (non-financial) tables still use permissive `USING (TRUE)` RLS. Estimates tables do not.

### What I would ship next

1. Stripe deposits / invoices for accepted estimates, with idempotent webhooks.
2. Invoice snapshot from an accepted estimate (immutable lines + totals).
3. Append-only `estimate_status_history` written in the same transaction as the transition.
4. Email / signed client link on send; notify on accept / reject.
5. RLS + Playwright in CI (create → send → accept, plus cross-tenant 404).
6. Scheduled idempotency purge, rate limits, PDF export, pipeline reporting.
