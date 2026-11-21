/**
 * GET /api/estimates — filtering, pagination and tenancy.
 *
 * The service runs against a read-only Supabase stub that implements the
 * filter operators the query builder uses (eq / ilike / gte / lte / order /
 * range), so "server-side filtering" is verified by what the SQL layer is
 * asked for and returns, not by post-processing in the test.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  estimateService,
  normalizeEstimateSearch,
  MAX_PAGE_SIZE,
} from '@/lib/estimate-service';
import { estimateListQuerySchema } from '@/lib/validation-schemas';
import { clearPermissionCache } from '@/lib/permission-checker';
import { PermissionError } from '@/lib/server-guards';
import type { UserWithRoles } from '@/lib/rbac-types';

// ---------------------------------------------------------------------------
// Read-only Supabase stub
// ---------------------------------------------------------------------------
type Row = Record<string, any>;

function likeToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/%/g, '.*').replace(/_/g, '.')}$`, 'i');
}

function createReadDb(seed: Record<string, Row[]>) {
  const tables: Record<string, Row[]> = {};
  Object.entries(seed).forEach(([table, rows]) => {
    tables[table] = rows.map((row) => ({ ...row }));
  });

  const from = (table: string) => {
    const filters: Array<(row: Row) => boolean> = [];
    const orders: Array<{ column: string; ascending: boolean }> = [];
    let range: [number, number] | null = null;

    const rows = () => tables[table] ?? [];
    const matched = () => rows().filter((row) => filters.every((f) => f(row)));

    const execute = () => {
      const total = matched().length;
      let list = matched().slice();

      for (const order of [...orders].reverse()) {
        list.sort((a, b) => {
          const left = a[order.column];
          const right = b[order.column];
          const cmp = left === right ? 0 : left > right ? 1 : -1;
          return order.ascending ? cmp : -cmp;
        });
      }

      const data = range ? list.slice(range[0], range[1] + 1) : list;
      return { data: data.map((row) => ({ ...row })), error: null, count: total };
    };

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
      ilike: (column: string, pattern: string) => {
        const regex = likeToRegex(pattern);
        filters.push((row) => regex.test(String(row[column] ?? '')));
        return chain;
      },
      gte: (column: string, value: any) => {
        filters.push((row) => String(row[column] ?? '') >= String(value));
        return chain;
      },
      lte: (column: string, value: any) => {
        filters.push((row) => String(row[column] ?? '') <= String(value));
        return chain;
      },
      order: (column: string, opts?: { ascending?: boolean }) => {
        orders.push({ column, ascending: opts?.ascending !== false });
        return chain;
      },
      range: (start: number, end: number) => {
        range = [start, end];
        return chain;
      },
      limit: (count: number) => {
        range = [0, count - 1];
        return chain;
      },
      maybeSingle: () => Promise.resolve({ data: execute().data[0] ?? null, error: null }),
      single: () => Promise.resolve({ data: execute().data[0] ?? null, error: null }),
      then: (ok: any, ko: any) => Promise.resolve(execute()).then(ok, ko),
    };

    return chain;
  };

  return { from, tables };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
// Real UUIDs: account_id is validated with the shared uuidSchema.
const ACCOUNT_A = '11111111-1111-1111-1111-111111111111';
const ACCOUNT_B = '22222222-2222-2222-2222-222222222222';

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
const outsider = profile('user-outsider', {
  view_estimates: true,
  create_estimates: true,
  update_estimates: true,
  send_estimates: true,
  accept_estimates: true,
  reject_estimates: true,
});
const nobody = profile('user-nobody', {});

function estimate(id: string, overrides: Row = {}): Row {
  return {
    id,
    account_id: ACCOUNT_A,
    project_id: null,
    estimate_number: `EST-${id}`,
    title: `Estimate ${id}`,
    description: null,
    status: 'draft',
    currency: 'USD',
    subtotal_minor: 1000,
    tax_minor: 0,
    total_minor: 1000,
    created_by: 'user-viewer',
    created_at: `2026-01-0${id.slice(-1)}T10:00:00.000Z`,
    updated_at: `2026-01-0${id.slice(-1)}T10:00:00.000Z`,
    ...overrides,
  };
}

function seed() {
  return {
    accounts: [{ id: ACCOUNT_A }, { id: ACCOUNT_B }],
    account_members: [
      { id: 'm-1', account_id: ACCOUNT_A, user_id: 'user-viewer', removed_at: null },
      { id: 'm-2', account_id: ACCOUNT_A, user_id: 'user-nobody', removed_at: null },
      { id: 'm-3', account_id: ACCOUNT_B, user_id: 'user-outsider', removed_at: null },
    ],
    estimates: [
      estimate('e1', { status: 'draft', project_id: 'proj-a', estimate_number: 'EST-100' }),
      estimate('e2', { status: 'sent', project_id: 'proj-a', estimate_number: 'EST-101' }),
      estimate('e3', { status: 'accepted', project_id: 'proj-b', estimate_number: 'EST-102' }),
      estimate('e4', { status: 'sent', project_id: 'proj-b', estimate_number: 'WEB-200' }),
      estimate('e5', { status: 'rejected', project_id: null, estimate_number: 'EST-103' }),
      estimate('e6', { status: 'draft', project_id: null, estimate_number: 'EST-104' }),
      estimate('b1', { account_id: ACCOUNT_B, estimate_number: 'EST-100', status: 'sent' }),
      estimate('b2', { account_id: ACCOUNT_B, estimate_number: 'OTHER-1' }),
    ],
  };
}

beforeEach(() => clearPermissionCache());

// ---------------------------------------------------------------------------
// Service filtering
// ---------------------------------------------------------------------------
describe('estimateService.listEstimates', () => {
  it('returns only the requested account', async () => {
    const db = createReadDb(seed());
    const result = await estimateService.listEstimates({ accountId: ACCOUNT_A }, viewer, db as any);

    expect(result.count).toBe(6);
    expect(result.estimates.every((e) => e.account_id === ACCOUNT_A)).toBe(true);
    expect(result.estimates.map((e) => e.id)).not.toContain('b1');
  });

  it('filters by status', async () => {
    const db = createReadDb(seed());
    const result = await estimateService.listEstimates(
      { accountId: ACCOUNT_A, status: 'sent' },
      viewer,
      db as any,
    );

    expect(result.estimates.map((e) => e.id).sort()).toEqual(['e2', 'e4']);
    expect(result.count).toBe(2);
  });

  it('filters by project', async () => {
    const db = createReadDb(seed());
    const result = await estimateService.listEstimates(
      { accountId: ACCOUNT_A, projectId: 'proj-b' },
      viewer,
      db as any,
    );

    expect(result.estimates.map((e) => e.id).sort()).toEqual(['e3', 'e4']);
  });

  it('searches estimate numbers case-insensitively', async () => {
    const db = createReadDb(seed());
    const result = await estimateService.listEstimates(
      { accountId: ACCOUNT_A, search: 'est-10' },
      viewer,
      db as any,
    );

    expect(result.estimates.map((e) => e.id).sort()).toEqual(['e1', 'e2', 'e3', 'e5', 'e6']);
    expect(result.count).toBe(5);
  });

  it('strips PostgREST operators from the search term', async () => {
    expect(normalizeEstimateSearch('%_(),*"')).toBeNull();
    expect(normalizeEstimateSearch('  EST-10%  ')).toBe('EST-10');
    expect(normalizeEstimateSearch('')).toBeNull();

    const db = createReadDb(seed());
    const result = await estimateService.listEstimates(
      { accountId: ACCOUNT_A, search: '%' },
      viewer,
      db as any,
    );
    // A bare wildcard must not widen the query beyond the tenant.
    expect(result.count).toBe(6);
    expect(result.estimates.every((e) => e.account_id === ACCOUNT_A)).toBe(true);
  });

  it('filters by created_at range', async () => {
    const db = createReadDb(seed());
    const result = await estimateService.listEstimates(
      {
        accountId: ACCOUNT_A,
        createdFrom: '2026-01-02',
        createdTo: '2026-01-04T23:59:59Z',
      },
      viewer,
      db as any,
    );

    expect(result.estimates.map((e) => e.id).sort()).toEqual(['e2', 'e3', 'e4']);
    expect(result.count).toBe(3);
  });

  it('paginates with a deterministic order and exact count', async () => {
    const db = createReadDb(seed());

    const page1 = await estimateService.listEstimates(
      { accountId: ACCOUNT_A, limit: 2, offset: 0 },
      viewer,
      db as any,
    );
    const page2 = await estimateService.listEstimates(
      { accountId: ACCOUNT_A, limit: 2, offset: 2 },
      viewer,
      db as any,
    );

    expect(page1.estimates).toHaveLength(2);
    expect(page2.estimates).toHaveLength(2);
    expect(page1.count).toBe(6);
    expect(page2.count).toBe(6);
    expect(page1.estimates.map((e) => e.id)).not.toEqual(page2.estimates.map((e) => e.id));
    // Newest first by default.
    expect(page1.estimates[0].id).toBe('e6');
  });

  it('supports ascending sorts', async () => {
    const db = createReadDb(seed());
    const result = await estimateService.listEstimates(
      { accountId: ACCOUNT_A, sort: 'estimate_number', direction: 'asc' },
      viewer,
      db as any,
    );

    expect(result.estimates.map((e) => e.estimate_number)).toEqual([
      'EST-100',
      'EST-101',
      'EST-102',
      'EST-103',
      'EST-104',
      'WEB-200',
    ]);
  });

  it('caps the page size', async () => {
    const db = createReadDb(seed());
    const result = await estimateService.listEstimates(
      { accountId: ACCOUNT_A, limit: 5000 },
      viewer,
      db as any,
    );
    expect(result.limit).toBe(MAX_PAGE_SIZE);
  });

  it('treats an empty result as a normal response', async () => {
    const db = createReadDb(seed());
    const result = await estimateService.listEstimates(
      { accountId: ACCOUNT_A, search: 'no-such-number' },
      viewer,
      db as any,
    );

    expect(result.estimates).toEqual([]);
    expect(result.count).toBe(0);
  });

  it('rejects reads from another account, even with every permission', async () => {
    const db = createReadDb(seed());
    await expect(
      estimateService.listEstimates({ accountId: ACCOUNT_A }, outsider, db as any),
    ).rejects.toThrow(PermissionError);
  });

  it('rejects readers without view_estimates', async () => {
    const db = createReadDb(seed());
    await expect(
      estimateService.listEstimates({ accountId: ACCOUNT_A }, nobody, db as any),
    ).rejects.toThrow(PermissionError);
  });
});

// ---------------------------------------------------------------------------
// Query validation
// ---------------------------------------------------------------------------
describe('estimateListQuerySchema', () => {
  it('applies defaults', () => {
    const parsed = estimateListQuerySchema.parse({ account_id: '11111111-1111-1111-1111-111111111111' });
    expect(parsed).toMatchObject({
      sort: 'created_at',
      direction: 'desc',
      limit: 25,
      offset: 0,
    });
  });

  it('requires a valid account_id', () => {
    expect(estimateListQuerySchema.safeParse({}).success).toBe(false);
    expect(estimateListQuerySchema.safeParse({ account_id: 'nope' }).success).toBe(false);
  });

  it('rejects unknown statuses, sorts and directions', () => {
    const base = { account_id: '11111111-1111-1111-1111-111111111111' };
    expect(estimateListQuerySchema.safeParse({ ...base, status: 'paid' }).success).toBe(false);
    expect(estimateListQuerySchema.safeParse({ ...base, sort: 'hacked' }).success).toBe(false);
    expect(estimateListQuerySchema.safeParse({ ...base, direction: 'sideways' }).success).toBe(false);
  });

  it('bounds pagination', () => {
    const base = { account_id: '11111111-1111-1111-1111-111111111111' };
    expect(estimateListQuerySchema.safeParse({ ...base, limit: '0' }).success).toBe(false);
    expect(estimateListQuerySchema.safeParse({ ...base, limit: '101' }).success).toBe(false);
    expect(estimateListQuerySchema.safeParse({ ...base, limit: 'abc' }).success).toBe(false);
    expect(estimateListQuerySchema.safeParse({ ...base, offset: '-1' }).success).toBe(false);
    expect(estimateListQuerySchema.parse({ ...base, limit: '100' }).limit).toBe(100);
  });

  it('rejects unknown query parameters', () => {
    const base = { account_id: '11111111-1111-1111-1111-111111111111' };
    expect(estimateListQuerySchema.safeParse({ ...base, accountId: 'x' }).success).toBe(false);
  });

  it('validates date bounds', () => {
    const base = { account_id: '11111111-1111-1111-1111-111111111111' };
    expect(estimateListQuerySchema.safeParse({ ...base, created_from: '2026-01-01' }).success).toBe(true);
    expect(
      estimateListQuerySchema.safeParse({ ...base, created_from: '2026-01-01T00:00:00Z' }).success,
    ).toBe(true);
    expect(estimateListQuerySchema.safeParse({ ...base, created_from: '01/01/2026' }).success).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// Route contract
// ---------------------------------------------------------------------------
const mockState = vi.hoisted(() => ({
  client: null as any,
  profile: null as any,
}));

vi.mock('@/lib/supabase-server', () => ({
  createApiSupabaseClient: () => mockState.client,
  getUserProfileFromRequest: async () => mockState.profile,
}));

import { GET } from '@/app/api/estimates/route';

const BASE = `http://localhost/api/estimates?account_id=${ACCOUNT_A}`;

async function call(path: string) {
  const response = await GET(new Request(path) as any);
  return { status: response.status, body: await response.json() };
}

describe('GET /api/estimates', () => {
  beforeEach(() => {
    clearPermissionCache();
    mockState.client = createReadDb(seed());
    mockState.profile = viewer;
  });

  it('returns 500 when the database client is unavailable', async () => {
    mockState.client = null;
    const result = await call(BASE);
    expect(result.status).toBe(500);
  });

  it('returns 401 for unauthenticated callers', async () => {
    mockState.profile = null;
    const result = await call(BASE);
    expect(result.status).toBe(401);
  });

  it('returns 400 for a missing or invalid account_id', async () => {
    expect((await call('http://localhost/api/estimates')).status).toBe(400);
    expect((await call('http://localhost/api/estimates?account_id=nope')).status).toBe(400);
  });

  it('returns 400 for invalid filters', async () => {
    expect((await call(`${BASE}&status=paid`)).status).toBe(400);
    expect((await call(`${BASE}&limit=500`)).status).toBe(400);
  });

  it('returns 403 for a non-member account', async () => {
    mockState.profile = outsider;
    const result = await call(`http://localhost/api/estimates?account_id=${ACCOUNT_A}`);
    expect(result.status).toBe(403);
  });

  it('lists only the account, filtered in SQL, with pagination metadata', async () => {
    const result = await call(`${BASE}&status=sent&limit=1&offset=0`);

    expect(result.status).toBe(200);
    expect(result.body.success).toBe(true);
    expect(result.body.pagination).toEqual({ count: 2, limit: 1, offset: 0, has_more: true });
    expect(result.body.estimates).toHaveLength(1);
    expect(result.body.estimates[0]).toMatchObject({ account_id: ACCOUNT_A, status: 'sent' });
  });

  it('applies the search filter server-side', async () => {
    const result = await call(`${BASE}&search=web`);
    expect(result.status).toBe(200);
    expect(result.body.estimates.map((e: Row) => e.id)).toEqual(['e4']);
  });

  it('returns an empty list as a valid 200 response', async () => {
    const result = await call(`${BASE}&search=zzz-nothing`);
    expect(result.status).toBe(200);
    expect(result.body.estimates).toEqual([]);
    expect(result.body.pagination).toMatchObject({ count: 0, has_more: false });
  });

  it('never returns another account\'s rows', async () => {
    const result = await call(BASE);
    expect(result.body.estimates.every((e: Row) => e.account_id === ACCOUNT_A)).toBe(true);
    expect(result.body.pagination.count).toBe(6);
  });
});
