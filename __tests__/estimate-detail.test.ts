/**
 * GET /api/estimates/[estimateId] — single estimate + line items.
 *
 * Real handler and service; only Supabase is stubbed (read-only queries).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { clearPermissionCache } from '@/lib/permission-checker';
import type { UserWithRoles } from '@/lib/rbac-types';

type Row = Record<string, any>;

const ACCOUNT_A = '11111111-1111-1111-1111-111111111111';
const ACCOUNT_B = '22222222-2222-2222-2222-222222222222';
const ESTIMATE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ESTIMATE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function profile(id: string, permissions: Record<string, boolean>): UserWithRoles {
  return {
    id,
    is_superadmin: false,
    user_roles: [
      { role_id: 'role-1', roles: { id: 'role-1', name: 'Test', is_system_role: false, permissions } },
    ],
  } as unknown as UserWithRoles;
}

const viewer = profile('user-viewer', { view_estimates: true });
const outsider = profile('user-outsider', { view_estimates: true, create_estimates: true });
const noView = profile('user-noview', { create_estimates: true });

function estimate(id: string, overrides: Row = {}): Row {
  return {
    id,
    account_id: ACCOUNT_A,
    project_id: null,
    estimate_number: 'EST-001',
    title: 'Website redesign',
    description: 'Phase one',
    status: 'draft',
    currency: 'USD',
    subtotal_minor: 30_000,
    tax_minor: 3000,
    total_minor: 33_000,
    // Internal column: must never appear in the API response.
    created_by: 'user-manager',
    internal_notes: 'do not expose',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
    ...overrides,
  };
}

function line(id: string, sortOrder: number, overrides: Row = {}): Row {
  return {
    id,
    estimate_id: ESTIMATE_A,
    description: `Line ${sortOrder}`,
    quantity: '1.500',
    unit_price_minor: 20_000,
    amount_minor: 30_000,
    sort_order: sortOrder,
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function seed() {
  return {
    accounts: [{ id: ACCOUNT_A }, { id: ACCOUNT_B }],
    account_members: [
      { id: 'm-1', account_id: ACCOUNT_A, user_id: 'user-viewer', removed_at: null },
      { id: 'm-2', account_id: ACCOUNT_A, user_id: 'user-noview', removed_at: null },
      { id: 'm-3', account_id: ACCOUNT_B, user_id: 'user-outsider', removed_at: null },
    ],
    estimates: [estimate(ESTIMATE_A), estimate(ESTIMATE_B, { account_id: ACCOUNT_B })],
    estimate_line_items: [
      line('l-2', 1, { description: 'Second' }),
      line('l-1', 0, { description: 'First' }),
      line('l-b', 0, { estimate_id: ESTIMATE_B }),
    ],
  };
}

function createReadDb(seedData: Record<string, Row[]>) {
  const tables: Record<string, Row[]> = {};
  Object.entries(seedData).forEach(([table, rows]) => {
    tables[table] = rows.map((row) => ({ ...row }));
  });

  const from = (table: string) => {
    const filters: Array<(row: Row) => boolean> = [];
    const rows = () => tables[table] ?? [];
    const matched = () => rows().filter((row) => filters.every((f) => f(row)));

    const chain: any = {
      select: () => chain,
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
      maybeSingle: () => Promise.resolve({ data: matched()[0] ?? null, error: null }),
      single: () => Promise.resolve({ data: matched()[0] ?? null, error: null }),
      then: (ok: any, ko: any) => Promise.resolve({ data: matched(), error: null }).then(ok, ko),
    };

    return chain;
  };

  return { from, tables };
}

const mockState = vi.hoisted(() => ({ client: null as any, profile: null as any }));

vi.mock('@/lib/supabase-server', () => ({
  createApiSupabaseClient: () => mockState.client,
  getUserProfileFromRequest: async () => mockState.profile,
}));

import { GET } from '@/app/api/estimates/[estimateId]/route';

async function get(estimateId: string, query = '') {
  const request = new Request(`http://localhost/api/estimates/${estimateId}${query}`);
  const response = await GET(request as any, {
    params: Promise.resolve({ estimateId }),
  });
  return { status: response.status, body: await response.json() };
}

beforeEach(() => {
  clearPermissionCache();
  mockState.client = createReadDb(seed());
  mockState.profile = viewer;
});

describe('GET /api/estimates/[estimateId] — guards', () => {
  it('returns 400 for a malformed estimate id, before touching the database', async () => {
    const result = await get('not-a-uuid');
    expect(result.status).toBe(400);
    expect(mockState.client.tables.estimates).toHaveLength(2);
  });

  it('returns 500 when the database client is unavailable', async () => {
    mockState.client = null;
    expect((await get(ESTIMATE_A)).status).toBe(500);
  });

  it('returns 401 for unauthenticated callers', async () => {
    mockState.profile = null;
    expect((await get(ESTIMATE_A)).status).toBe(401);
  });

  it('returns 400 for invalid query parameters', async () => {
    expect((await get(ESTIMATE_A, '?account_id=nope')).status).toBe(400);
    expect((await get(ESTIMATE_A, '?unknown=1')).status).toBe(400);
  });
});

describe('GET /api/estimates/[estimateId] — tenancy', () => {
  it('never returns another account\'s estimate', async () => {
    const result = await get(ESTIMATE_B);
    expect(result.status).toBe(404);
    expect(result.body.error).toBe('Estimate not found');
    expect(JSON.stringify(result.body)).not.toMatch(/EST-001/);
  });

  it('returns the same 404 whether the estimate is missing or unauthorized', async () => {
    const missing = await get('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
    const foreign = await get(ESTIMATE_B);

    expect(missing.status).toBe(foreign.status);
    expect(missing.body).toEqual(foreign.body);
  });

  it('returns 403 for an in-account caller without view_estimates', async () => {
    mockState.profile = noView;
    expect((await get(ESTIMATE_A)).status).toBe(403);
  });

  it('rejects an account_id context that does not own the estimate', async () => {
    const result = await get(ESTIMATE_A, `?account_id=${ACCOUNT_B}`);
    expect(result.status).toBe(404);
  });

  it('accepts the owning account_id context', async () => {
    const result = await get(ESTIMATE_A, `?account_id=${ACCOUNT_A}`);
    expect(result.status).toBe(200);
    expect(result.body.estimate.id).toBe(ESTIMATE_A);
  });
});

describe('GET /api/estimates/[estimateId] — payload', () => {
  it('returns the estimate with its line items ordered by sort_order', async () => {
    const result = await get(ESTIMATE_A);

    expect(result.status).toBe(200);
    expect(result.body.success).toBe(true);
    expect(result.body.estimate.line_items.map((l: Row) => l.description)).toEqual([
      'First',
      'Second',
    ]);
    // Lines from another estimate never appear.
    expect(result.body.estimate.line_items.map((l: Row) => l.id)).not.toContain('l-b');
  });

  it('exposes only allowlisted fields', async () => {
    const result = await get(ESTIMATE_A);
    const estimate = result.body.estimate;

    expect(Object.keys(estimate).sort()).toEqual(
      [
        'account_id',
        'created_at',
        'currency',
        'description',
        'estimate_number',
        'id',
        'line_items',
        'project_id',
        'status',
        'subtotal_minor',
        'tax_minor',
        'title',
        'total_minor',
        'updated_at',
      ].sort(),
    );

    expect(estimate.created_by).toBeUndefined();
    expect(estimate.internal_notes).toBeUndefined();
    expect(Object.keys(estimate.line_items[0]).sort()).toEqual(
      [
        'amount_minor',
        'description',
        'estimate_id',
        'id',
        'quantity',
        'sort_order',
        'unit_price_minor',
      ].sort(),
    );
  });

  it('returns monetary values as integers in minor units', async () => {
    const result = await get(ESTIMATE_A);
    const { estimate } = result.body;

    for (const value of [estimate.subtotal_minor, estimate.tax_minor, estimate.total_minor]) {
      expect(Number.isInteger(value)).toBe(true);
    }
    expect(estimate.total_minor).toBe(estimate.subtotal_minor + estimate.tax_minor);
  });
});
