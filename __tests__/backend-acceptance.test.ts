/**
 * BACKEND ACCEPTANCE SUITE (Task 14)
 *
 * One file that verifies the required backend contract end to end:
 *
 *   Unauthenticated request ........ 401
 *   Unauthorized user .............. 403
 *   Wrong account .................. no access (403 list / 404 by id)
 *   Valid draft creation ........... 201
 *   Invalid payload ................ 400
 *   Missing idempotency key ........ rejected
 *   Repeated idempotency key ....... no duplicate
 *   Different payload, same key .... 409
 *   Invalid project association .... rejected
 *   Invalid lifecycle transition ... 409
 *   Valid lifecycle transition ..... 200
 *   Monetary calculations .......... exact expected values
 *   Concurrent creation ............ one estimate
 *
 * ── MOCKED vs REAL DATABASE ────────────────────────────────────────────────
 * Everything below is a MOCKED test: the real route handlers, the real
 * service, the real money library and the real zod schemas run against an
 * in-memory Supabase stub. No Postgres, RLS policy, trigger, unique index or
 * `auth.uid()` is exercised.
 *
 * REAL database / RLS integration tests DO NOT EXIST in this environment:
 * there is no local Supabase CLI, no `supabase/config.toml`, no `psql`, and
 * Docker's daemon is not running. When a database is available, these cases
 * must be repeated unchanged but backed by the real schema:
 *   - anon key + no session:  SELECT/INSERT on estimates returns 0 rows / error
 *   - authenticated member of A: cannot SELECT, INSERT, UPDATE or transition a
 *     B estimate (RLS + the SECURITY DEFINER idempotency function)
 *   - unique (user_id, account_id, idempotency_key) arbitration under two real
 *     concurrent transactions
 *   - the generated `amount_minor` column and the totals CHECK constraint
 *   - `create_estimate_idempotent` rollback leaving no key behind
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { computeEstimate } from '@/lib/estimate-money';
import { clearPermissionCache } from '@/lib/permission-checker';
import type { UserWithRoles } from '@/lib/rbac-types';

type Row = Record<string, any>;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const ACCOUNT_A = '11111111-1111-1111-1111-111111111111';
const ACCOUNT_B = '22222222-2222-2222-2222-222222222222';
const PROJECT_A = '33333333-3333-3333-3333-333333333333';
const PROJECT_B = '44444444-4444-4444-4444-444444444444';
const EST_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const EST_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const IDEMPOTENCY_KEY = 'acceptance-key-0001';

function profile(id: string, permissions: Record<string, boolean>): UserWithRoles {
  return {
    id,
    is_superadmin: false,
    user_roles: [
      { role_id: 'role-1', roles: { id: 'role-1', name: 'Test', is_system_role: false, permissions } },
    ],
  } as unknown as UserWithRoles;
}

const ALL = {
  view_estimates: true,
  create_estimates: true,
  update_estimates: true,
  send_estimates: true,
  accept_estimates: true,
  reject_estimates: true,
};
const manager = profile('user-manager', ALL);
const memberNoPermissions = profile('user-no-perm', {});
const memberViewOnly = profile('user-viewer', { view_estimates: true });
const outsider = profile('user-outsider', ALL); // member of account B only

function estimateRow(id: string, accountId: string, status = 'draft'): Row {
  return {
    id,
    account_id: accountId,
    project_id: null,
    estimate_number: 'EST-001',
    title: 'Website redesign',
    description: null,
    status,
    currency: 'USD',
    subtotal_minor: 30_000,
    tax_minor: 3000,
    total_minor: 33_000,
    created_by: 'user-manager',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

// ---------------------------------------------------------------------------
// In-memory Supabase stub (reads, conditional updates, idempotent RPC)
// ---------------------------------------------------------------------------
function createBackend() {
  const tables: Record<string, Row[]> = {
    accounts: [{ id: ACCOUNT_A }, { id: ACCOUNT_B }],
    account_members: [
      { id: 'm-1', account_id: ACCOUNT_A, user_id: 'user-manager', removed_at: null },
      { id: 'm-2', account_id: ACCOUNT_A, user_id: 'user-no-perm', removed_at: null },
      { id: 'm-3', account_id: ACCOUNT_A, user_id: 'user-viewer', removed_at: null },
      { id: 'm-4', account_id: ACCOUNT_B, user_id: 'user-outsider', removed_at: null },
    ],
    projects: [
      { id: PROJECT_A, account_id: ACCOUNT_A },
      { id: PROJECT_B, account_id: ACCOUNT_B },
    ],
    estimates: [estimateRow(EST_A, ACCOUNT_A), estimateRow(EST_B, ACCOUNT_B, 'sent')],
    estimate_line_items: [],
  };

  const keys = new Map<string, { hash: string; body: any; estimateId: string }>();
  const failures: Row[] = [];
  let seq = 0;

  const from = (table: string) => {
    const filters: Array<(row: Row) => boolean> = [];
    let action: 'select' | 'update' = 'select';
    let payload: Row = {};

    const rows = () => tables[table] ?? [];
    const matched = () => rows().filter((row) => filters.every((f) => f(row)));

    const execute = () => {
      if (action === 'update') {
        const hits = matched();
        hits.forEach((row) => Object.assign(row, payload));
        return { data: hits.map((row) => ({ ...row })), error: null, count: hits.length };
      }
      return { data: matched().map((row) => ({ ...row })), error: null, count: matched().length };
    };

    const chain: any = {
      select: () => chain,
      update: (value: Row) => {
        action = 'update';
        payload = value;
        return chain;
      },
      eq: (column: string, value: any) => {
        filters.push((row) => row[column] === value);
        return chain;
      },
      is: (column: string, value: any) => {
        filters.push((row) => (row[column] ?? null) === value);
        return chain;
      },
      in: () => chain,
      limit: () => chain,
      order: () => chain,
      range: () => chain,
      maybeSingle: () => {
        const result = execute();
        return Promise.resolve({ data: result.data[0] ?? null, error: result.error });
      },
      single: () => {
        const result = execute();
        return Promise.resolve({ data: result.data[0] ?? null, error: result.error });
      },
      then: (ok: any, ko: any) => Promise.resolve(execute()).then(ok, ko),
    };

    return chain;
  };

  const rpc = async (name: string, params: Row) => {
    if (name !== 'create_estimate_idempotent') {
      return { data: null, error: { code: '42883', message: `unknown function ${name}` } };
    }

    await Promise.resolve(); // interleaving point for concurrent callers

    if (failures.length > 0) return { data: null, error: failures.shift() };

    const scope = `${params.p_account_id}::${params.p_idempotency_key}`;
    const existing = keys.get(scope);

    if (existing) {
      if (existing.hash !== params.p_request_hash) {
        return {
          data: [{ outcome: 'conflict', response_status: 409, response_body: null, estimate_id: existing.estimateId }],
          error: null,
        };
      }
      return {
        data: [
          {
            outcome: 'replay',
            response_status: 201,
            response_body: existing.body,
            estimate_id: existing.estimateId,
          },
        ],
        error: null,
      };
    }

    const estimate = {
      ...estimateRow(`est-${++seq}`, params.p_account_id),
      project_id: params.p_project_id,
      estimate_number: params.p_estimate_number,
      title: params.p_title,
      currency: params.p_currency,
      subtotal_minor: params.p_subtotal_minor,
      tax_minor: params.p_tax_minor,
      total_minor: params.p_total_minor,
      created_by: 'user-manager',
    };

    const lines = (params.p_lines ?? []).map((line: Row, i: number) => ({
      id: `line-${seq}-${i}`,
      estimate_id: estimate.id,
      description: line.description,
      quantity: line.quantity,
      unit_price_minor: line.unit_price_minor,
      amount_minor: Math.round(Number(line.quantity) * line.unit_price_minor),
      sort_order: line.sort_order ?? i,
      created_at: '2026-01-01T00:00:00.000Z',
    }));

    tables.estimates.push(estimate);
    tables.estimate_line_items.push(...lines);

    const body = { estimate, lineItems: lines };
    keys.set(scope, { hash: params.p_request_hash, body, estimateId: estimate.id });

    return {
      data: [{ outcome: 'created', response_status: 201, response_body: body, estimate_id: estimate.id }],
      error: null,
    };
  };

  return { from, rpc, tables, keys };
}

// ---------------------------------------------------------------------------
// Route harness
// ---------------------------------------------------------------------------
const mockState = vi.hoisted(() => ({ client: null as any, profile: null as any }));

vi.mock('@/lib/supabase-server', () => ({
  createApiSupabaseClient: () => mockState.client,
  getUserProfileFromRequest: async () => mockState.profile,
}));

import { GET as listEstimates, POST as createEstimate } from '@/app/api/estimates/route';
import { GET as getEstimate } from '@/app/api/estimates/[estimateId]/route';
import { POST as sendEstimate } from '@/app/api/estimates/[estimateId]/send/route';

const validPayload = {
  account_id: ACCOUNT_A,
  estimate_number: 'EST-777',
  title: 'Website redesign',
  currency: 'USD',
  line_items: [{ description: 'Discovery', quantity: '2.5', unit_price_minor: 12_000 }],
  tax_rate_bps: 1000,
};

async function call(handler: any, url: string, init?: RequestInit, params?: Row) {
  const request = new Request(url, init);
  const response = await handler(
    request as any,
    params ? { params: Promise.resolve(params) } : undefined,
  );
  return { status: response.status, body: await response.json() };
}

function createRequest(body: unknown, headers: Record<string, string> = { 'Idempotency-Key': IDEMPOTENCY_KEY }) {
  return {
    url: 'http://localhost/api/estimates',
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    } as RequestInit,
  };
}

beforeEach(() => {
  clearPermissionCache();
  mockState.client = createBackend();
  mockState.profile = manager;
});

// ---------------------------------------------------------------------------
// 1-3. Authentication, authorization, tenancy
// ---------------------------------------------------------------------------
describe('acceptance: authentication and tenancy', () => {
  it('unauthenticated request → 401', async () => {
    mockState.profile = null;
    const { url, init } = createRequest(validPayload);
    expect((await call(createEstimate, url, init)).status).toBe(401);

    clearPermissionCache();
    expect((await call(listEstimates, `http://localhost/api/estimates?account_id=${ACCOUNT_A}`)).status).toBe(
      401,
    );

    clearPermissionCache();
    expect((await call(getEstimate, `http://localhost/api/estimates/${EST_A}`, undefined, { estimateId: EST_A })).status).toBe(401);
  });

  it('unauthorized user (member without permissions) → 403', async () => {
    mockState.profile = memberNoPermissions;

    const create = createRequest(validPayload);
    expect((await call(createEstimate, create.url, create.init)).status).toBe(403);
    expect((mockState.client.tables.estimates as Row[])).toHaveLength(2); // nothing created

    const list = await call(
      listEstimates,
      `http://localhost/api/estimates?account_id=${ACCOUNT_A}`,
    );
    expect(list.status).toBe(403);

    const detail = await call(getEstimate, `http://localhost/api/estimates/${EST_A}`, undefined, {
      estimateId: EST_A,
    });
    expect(detail.status).toBe(403);
    expect(detail.body.estimate).toBeUndefined();
  });

  it('wrong account → no access and no data leak', async () => {
    mockState.profile = outsider; // member of B only, every permission

    const list = await call(
      listEstimates,
      `http://localhost/api/estimates?account_id=${ACCOUNT_A}`,
    );
    expect(list.status).toBe(403);
    expect(list.body.estimates).toBeUndefined();

    const detail = await call(getEstimate, `http://localhost/api/estimates/${EST_A}`, undefined, {
      estimateId: EST_A,
    });
    expect(detail.status).toBe(404);
    expect(JSON.stringify(detail.body)).not.toMatch(/EST-001|Website redesign/);

    const transition = await call(
      sendEstimate,
      `http://localhost/api/estimates/${EST_A}/send`,
      { method: 'POST' },
      { estimateId: EST_A },
    );
    expect(transition.status).toBe(404);
    expect((mockState.client.tables.estimates as Row[]).find((e) => e.id === EST_A)!.status).toBe(
      'draft',
    );
  });
});

// ---------------------------------------------------------------------------
// 4-9. Creation, validation, idempotency, project ownership
// ---------------------------------------------------------------------------
describe('acceptance: creation', () => {
  it('valid draft creation → 201 with server-calculated totals', async () => {
    const { url, init } = createRequest(validPayload);
    const result = await call(createEstimate, url, init);

    expect(result.status).toBe(201);
    expect(result.body.estimate).toMatchObject({
      status: 'draft',
      currency: 'USD',
      subtotal_minor: 30_000,
      tax_minor: 3000,
      total_minor: 33_000,
    });
    expect(result.body.line_items).toHaveLength(1);
    expect(result.body.line_items[0].amount_minor).toBe(30_000);
  });

  it('invalid payload → 400', async () => {
    const blankTitle = createRequest({ ...validPayload, title: '  ' });
    expect((await call(createEstimate, blankTitle.url, blankTitle.init)).status).toBe(400);

    const negativePrice = createRequest({
      ...validPayload,
      line_items: [{ description: 'Work', quantity: 1, unit_price_minor: -1 }],
    });
    expect((await call(createEstimate, negativePrice.url, negativePrice.init)).status).toBe(400);

    const clientTotals = createRequest({ ...validPayload, subtotal_minor: 1, total_minor: 1 });
    expect((await call(createEstimate, clientTotals.url, clientTotals.init)).status).toBe(400);

    const badCurrency = createRequest({ ...validPayload, currency: 'US' });
    expect((await call(createEstimate, badCurrency.url, badCurrency.init)).status).toBe(400);
  });

  it('missing idempotency key → rejected', async () => {
    const { url, init } = createRequest(validPayload, {});
    const result = await call(createEstimate, url, init);

    expect(result.status).toBe(400);
    expect(result.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect((mockState.client.tables.estimates as Row[])).toHaveLength(2);
  });

  it('repeated idempotency key → no duplicate', async () => {
    const first = createRequest(validPayload);
    const created = await call(createEstimate, first.url, first.init);

    for (let i = 0; i < 9; i++) {
      const retry = createRequest(validPayload);
      const replay = await call(createEstimate, retry.url, retry.init);
      expect(replay.status).toBe(200);
      expect(replay.body.replayed).toBe(true);
      expect(replay.body.estimate.id).toBe(created.body.estimate.id);
    }

    expect((mockState.client.tables.estimates as Row[])).toHaveLength(3); // 2 seeded + 1
  });

  it('different payload with the same key → 409', async () => {
    const first = createRequest(validPayload);
    await call(createEstimate, first.url, first.init);

    const changed = createRequest({
      ...validPayload,
      line_items: [{ description: 'Discovery', quantity: '3', unit_price_minor: 12_000 }],
    });
    const conflict = await call(createEstimate, changed.url, changed.init);

    expect(conflict.status).toBe(409);
    expect((mockState.client.tables.estimates as Row[])).toHaveLength(3);
  });

  it('invalid project association → rejected', async () => {
    const foreignProject = createRequest({ ...validPayload, project_id: PROJECT_B });
    expect((await call(createEstimate, foreignProject.url, foreignProject.init)).status).toBe(400);

    const unknownProject = createRequest({
      ...validPayload,
      project_id: '99999999-9999-4999-8999-999999999999',
    });
    expect((await call(createEstimate, unknownProject.url, unknownProject.init)).status).toBe(400);

    expect((mockState.client.tables.estimates as Row[])).toHaveLength(2);

    const ownProject = createRequest({ ...validPayload, project_id: PROJECT_A });
    const accepted = await call(createEstimate, ownProject.url, ownProject.init);
    expect(accepted.status).toBe(201);
    expect(accepted.body.estimate.project_id).toBe(PROJECT_A);
  });

  it('concurrent creation with one key → exactly one estimate', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => {
        const { url, init } = createRequest(validPayload);
        return call(createEstimate, url, init);
      }),
    );

    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 200)).toHaveLength(4);
    expect((mockState.client.tables.estimates as Row[])).toHaveLength(3);
    expect(new Set(results.map((r) => r.body.estimate.id)).size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 10-11. Lifecycle
// ---------------------------------------------------------------------------
describe('acceptance: lifecycle', () => {
  it('invalid lifecycle transition → 409 and no state change', async () => {
    // Same account (so access is granted), but already sent -> send is invalid.
    (mockState.client.tables.estimates as Row[]).find((e) => e.id === EST_A)!.status = 'sent';

    const result = await call(
      sendEstimate,
      `http://localhost/api/estimates/${EST_A}/send`,
      { method: 'POST' },
      { estimateId: EST_A },
    );
    expect(result.status).toBe(409);
    expect(result.body.code).toBe('ESTIMATE_CONFLICT');
    expect((mockState.client.tables.estimates as Row[]).find((e) => e.id === EST_A)!.status).toBe(
      'sent',
    );
  });

  it('valid lifecycle transition → 200', async () => {
    const result = await call(
      sendEstimate,
      `http://localhost/api/estimates/${EST_A}/send`,
      { method: 'POST' },
      { estimateId: EST_A },
    );

    expect(result.status).toBe(200);
    expect(result.body.previous_status).toBe('draft');
    expect(result.body.status).toBe('sent');
    expect((mockState.client.tables.estimates as Row[]).find((e) => e.id === EST_A)!.status).toBe(
      'sent',
    );
  });
});

// ---------------------------------------------------------------------------
// 12. Money
// ---------------------------------------------------------------------------
describe('acceptance: monetary calculations', () => {
  const calculate = (lines: any[], taxRateBps?: number) => {
    const result = computeEstimate(lines, { taxRateBps });
    if (!result.ok) throw new Error(result.error.message);
    return result.value.totals;
  };

  it('uses exact integer minor units with no float drift', () => {
    expect(calculate([{ description: 'a', quantity: '2.5', unit_price_minor: 12_000 }])).toEqual({
      subtotalMinor: 30_000,
      taxMinor: 0,
      totalMinor: 30_000,
    });

    // 0.1 + 0.2 style artifacts are rejected, not rounded.
    expect(computeEstimate([{ description: 'a', quantity: 0.1 + 0.2, unit_price_minor: 100 }]).ok).toBe(
      false,
    );
  });

  it('rounds half away from zero exactly like PostgreSQL', () => {
    expect(calculate([{ description: 'a', quantity: '0.335', unit_price_minor: 100 }]).subtotalMinor).toBe(34);
    expect(calculate([{ description: 'a', quantity: '0.333', unit_price_minor: 100 }]).subtotalMinor).toBe(33);
    expect(calculate([{ description: 'a', quantity: '2.5', unit_price_minor: 1 }]).subtotalMinor).toBe(3);
  });

  it('computes subtotal, tax and total exactly across lines', () => {
    const first = calculate([
      { description: 'Discovery', quantity: '2.5', unit_price_minor: 12_000 },
      { description: 'Build', quantity: 3, unit_price_minor: 45_000 },
    ]);

    // 2.5 * 12000 = 30000 ; 3 * 45000 = 135000 ; subtotal 165000
    expect(first.subtotalMinor).toBe(165_000);

    const taxed = calculate(
      [
        { description: 'Discovery', quantity: '2.5', unit_price_minor: 12_000 },
        { description: 'Build', quantity: 3, unit_price_minor: 45_000 },
      ],
      825,
    );

    // 165000 * 8.25% = 13612.5 -> 13613
    expect(taxed).toEqual({ subtotalMinor: 165_000, taxMinor: 13_613, totalMinor: 178_613 });
  });

  it('matches the totals persisted by the creation endpoint', async () => {
    const { url, init } = createRequest({
      ...validPayload,
      line_items: [
        { description: 'Discovery', quantity: '2.5', unit_price_minor: 12_000 },
        { description: 'Build', quantity: 3, unit_price_minor: 45_000 },
      ],
      tax_rate_bps: 825,
    });

    const result = await call(createEstimate, url, init);
    expect(result.status).toBe(201);
    expect(result.body.estimate).toMatchObject({
      subtotal_minor: 165_000,
      tax_minor: 13_613,
      total_minor: 178_613,
    });
    expect(result.body.line_items.map((l: Row) => l.amount_minor)).toEqual([30_000, 135_000]);
  });
});
