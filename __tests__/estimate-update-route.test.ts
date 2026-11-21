/**
 * PATCH /api/estimates/[estimateId] — draft editing contract.
 *
 * Real route + service; Supabase is stubbed with read/write support so the
 * draft-only rule, the compare-and-set update and the line replacement run.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { clearPermissionCache } from '@/lib/permission-checker';
import type { UserWithRoles } from '@/lib/rbac-types';

type Row = Record<string, any>;

const ACCOUNT_A = '11111111-1111-1111-1111-111111111111';
const ACCOUNT_B = '22222222-2222-2222-2222-222222222222';
const EST_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const EST_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function profile(id: string, permissions: Record<string, boolean>): UserWithRoles {
  return {
    id,
    is_superadmin: false,
    user_roles: [
      { role_id: 'role-1', roles: { id: 'role-1', name: 'Test', is_system_role: false, permissions } },
    ],
  } as unknown as UserWithRoles;
}

const manager = profile('user-manager', { view_estimates: true, update_estimates: true });
const viewer = profile('user-viewer', { view_estimates: true });

function estimate(id: string, accountId: string, status = 'draft'): Row {
  return {
    id,
    account_id: accountId,
    project_id: null,
    estimate_number: 'EST-001',
    title: 'Original title',
    description: null,
    status,
    currency: 'USD',
    subtotal_minor: 100_000,
    tax_minor: 0,
    total_minor: 100_000,
    created_by: 'user-manager',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

function createBackend(status = 'draft') {
  const tables: Record<string, Row[]> = {
    accounts: [{ id: ACCOUNT_A }, { id: ACCOUNT_B }],
    account_members: [
      { id: 'm-1', account_id: ACCOUNT_A, user_id: 'user-manager', removed_at: null },
      { id: 'm-2', account_id: ACCOUNT_A, user_id: 'user-viewer', removed_at: null },
      { id: 'm-3', account_id: ACCOUNT_B, user_id: 'user-outsider', removed_at: null },
    ],
    projects: [],
    estimates: [estimate(EST_A, ACCOUNT_A, status), estimate(EST_B, ACCOUNT_B)],
    estimate_line_items: [
      {
        id: 'l-old',
        estimate_id: EST_A,
        description: 'Old line',
        quantity: '1.000',
        unit_price_minor: 100_000,
        amount_minor: 100_000,
        sort_order: 0,
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ],
  };

  let seq = 0;

  const from = (table: string) => {
    const filters: Array<(row: Row) => boolean> = [];
    let action: 'select' | 'update' | 'insert' | 'delete' = 'select';
    let payload: any = null;

    const rows = () => (tables[table] ??= []);
    const matched = () => rows().filter((row) => filters.every((f) => f(row)));

    const execute = () => {
      if (action === 'insert') {
        const items = (Array.isArray(payload) ? payload : [payload]).map((item: Row) => ({
          id: item.id ?? `${table}-${++seq}`,
          created_at: item.created_at ?? '2026-01-02T00:00:00.000Z',
          ...item,
        }));
        rows().push(...items);
        return { data: items.map((row) => ({ ...row })), error: null };
      }
      if (action === 'update') {
        const hits = matched();
        hits.forEach((row) => Object.assign(row, payload));
        return { data: hits.map((row) => ({ ...row })), error: null };
      }
      if (action === 'delete') {
        const hits = matched();
        tables[table] = rows().filter((row) => !hits.includes(row));
        return { data: null, error: null };
      }
      return { data: matched().map((row) => ({ ...row })), error: null };
    };

    const chain: any = {
      select: () => chain,
      insert: (value: any) => {
        action = 'insert';
        payload = value;
        return chain;
      },
      update: (value: Row) => {
        action = 'update';
        payload = value;
        return chain;
      },
      delete: () => {
        action = 'delete';
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
        return Promise.resolve({ data: result.data?.[0] ?? null, error: result.error });
      },
      single: () => {
        const result = execute();
        return Promise.resolve({ data: result.data?.[0] ?? null, error: result.error });
      },
      then: (ok: any, ko: any) => Promise.resolve(execute()).then(ok, ko),
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

import { PATCH } from '@/app/api/estimates/[estimateId]/route';

async function patch(estimateId: string, body: unknown) {
  const request = new Request(`http://localhost/api/estimates/${estimateId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const response = await PATCH(request as any, { params: Promise.resolve({ estimateId }) });
  return { status: response.status, body: await response.json() };
}

beforeEach(() => {
  clearPermissionCache();
  mockState.client = createBackend('draft');
  mockState.profile = manager;
});

describe('PATCH /api/estimates/[estimateId]', () => {
  it('updates a draft and recalculates totals from the new lines', async () => {
    const result = await patch(EST_A, {
      title: 'Updated title',
      line_items: [{ description: 'New work', quantity: '1.5', unit_price_minor: 20_000 }],
      tax_rate_bps: 1000,
    });

    expect(result.status).toBe(200);
    expect(result.body.estimate).toMatchObject({
      title: 'Updated title',
      status: 'draft',
      subtotal_minor: 30_000,
      tax_minor: 3000,
      total_minor: 33_000,
    });
    expect(result.body.estimate.created_by).toBeUndefined();
    expect(result.body.estimate.line_items).toHaveLength(1);
    expect(result.body.estimate.line_items[0].description).toBe('New work');

    const lines = (mockState.client.tables.estimate_line_items as Row[]).filter(
      (line) => line.estimate_id === EST_A,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].description).toBe('New work');
  });

  it('rejects client-supplied totals', async () => {
    const result = await patch(EST_A, { title: 'X', subtotal_minor: 1 });
    expect(result.status).toBe(400);
    expect((mockState.client.tables.estimates as Row[]).find((e) => e.id === EST_A)!.title).toBe(
      'Original title',
    );
  });

  it('refuses to edit a non-draft estimate', async () => {
    for (const status of ['sent', 'accepted', 'rejected']) {
      mockState.client = createBackend(status);
      clearPermissionCache();

      const result = await patch(EST_A, { title: 'Sneaky' });
      expect(result.status).toBe(409);
      expect((mockState.client.tables.estimates as Row[]).find((e) => e.id === EST_A)!.title).toBe(
        'Original title',
      );
    }
  });

  it('requires update_estimates', async () => {
    mockState.profile = viewer;
    const result = await patch(EST_A, { title: 'Nope' });
    expect(result.status).toBe(403);
  });

  it('returns 404 for another account\'s estimate', async () => {
    const result = await patch(EST_B, { title: 'Nope' });
    expect(result.status).toBe(404);
    expect((mockState.client.tables.estimates as Row[]).find((e) => e.id === EST_B)!.title).toBe(
      'Original title',
    );
  });

  it('returns 400 for a malformed id and 401 when unauthenticated', async () => {
    expect((await patch('nope', { title: 'X' })).status).toBe(400);

    mockState.profile = null;
    expect((await patch(EST_A, { title: 'X' })).status).toBe(401);
  });
});
