/**
 * Lifecycle API — send / accept / reject.
 *
 * Real routes, real handler glue, real service; only Supabase is stubbed.
 * The stub applies `update(...).eq('id').eq('status')` literally, so the
 * compare-and-set behaviour (including losing a race) is actually exercised.
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

const ALL = {
  view_estimates: true,
  create_estimates: true,
  update_estimates: true,
  send_estimates: true,
  accept_estimates: true,
  reject_estimates: true,
};
const manager = profile('user-manager', ALL);
const sender = profile('user-sender', { view_estimates: true, send_estimates: true });
const viewer = profile('user-viewer', { view_estimates: true });

function estimate(id: string, status: string, overrides: Row = {}): Row {
  return {
    id,
    account_id: ACCOUNT_A,
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
    ...overrides,
  };
}

function createBackend(status: string, options: { before?: (table: string, action: string) => void } = {}) {
  const tables: Record<string, Row[]> = {
    accounts: [{ id: ACCOUNT_A }, { id: ACCOUNT_B }],
    account_members: [
      { id: 'm-1', account_id: ACCOUNT_A, user_id: 'user-manager', removed_at: null },
      { id: 'm-2', account_id: ACCOUNT_A, user_id: 'user-sender', removed_at: null },
      { id: 'm-3', account_id: ACCOUNT_A, user_id: 'user-viewer', removed_at: null },
      { id: 'm-4', account_id: ACCOUNT_B, user_id: 'user-outsider', removed_at: null },
    ],
    estimates: [estimate(EST_A, status), estimate(EST_B, 'sent', { account_id: ACCOUNT_B })],
    estimate_line_items: [
      { id: 'l-1', estimate_id: EST_A, description: 'Work', quantity: '1.000', unit_price_minor: 30_000, amount_minor: 30_000, sort_order: 0, created_at: '2026-01-01T00:00:00.000Z' },
    ],
  };

  const from = (table: string) => {
    const filters: Array<(row: Row) => boolean> = [];
    let action: 'select' | 'update' = 'select';
    let payload: Row = {};

    const rows = () => tables[table] ?? [];
    const matched = () => rows().filter((row) => filters.every((f) => f(row)));

    const execute = () => {
      if (action === 'update') {
        options.before?.(table, action);
        const hits = matched();
        hits.forEach((row) => Object.assign(row, payload));
        return { data: hits.map((row) => ({ ...row })), error: null };
      }
      return { data: matched().map((row) => ({ ...row })), error: null };
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

  return { from, tables };
}

const mockState = vi.hoisted(() => ({ client: null as any, profile: null as any }));

vi.mock('@/lib/supabase-server', () => ({
  createApiSupabaseClient: () => mockState.client,
  getUserProfileFromRequest: async () => mockState.profile,
}));

import { POST as sendAction } from '@/app/api/estimates/[estimateId]/send/route';
import { POST as acceptAction } from '@/app/api/estimates/[estimateId]/accept/route';
import { POST as rejectAction } from '@/app/api/estimates/[estimateId]/reject/route';
import * as sendModule from '@/app/api/estimates/[estimateId]/send/route';
import * as acceptModule from '@/app/api/estimates/[estimateId]/accept/route';
import * as rejectModule from '@/app/api/estimates/[estimateId]/reject/route';

type Handler = (request: NextRequestLike, context: { params: Promise<{ estimateId: string }> }) => Promise<any>;
type NextRequestLike = any;

async function call(handler: Handler, estimateId: string, body?: unknown) {
  const request = new Request(`http://localhost/api/estimates/${estimateId}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const response = await handler(request, { params: Promise.resolve({ estimateId }) });
  return { status: response.status, body: await response.json() };
}

function currentStatus(): string {
  return (mockState.client.tables.estimates as Row[]).find((e) => e.id === EST_A)!.status;
}

beforeEach(() => {
  clearPermissionCache();
  mockState.client = createBackend('draft');
  mockState.profile = manager;
});

describe('lifecycle transitions', () => {
  it('sends a draft', async () => {
    const result = await call(sendAction, EST_A);

    expect(result.status).toBe(200);
    expect(result.body.status).toBe('sent');
    expect(result.body.previous_status).toBe('draft');
    expect(currentStatus()).toBe('sent');
  });

  it('accepts and rejects a sent estimate', async () => {
    mockState.client = createBackend('sent');
    const accepted = await call(acceptAction, EST_A);
    expect(accepted.status).toBe(200);
    expect(accepted.body.estimate.status).toBe('accepted');

    clearPermissionCache();
    mockState.client = createBackend('sent');
    const rejected = await call(rejectAction, EST_A);
    expect(rejected.status).toBe(200);
    expect(rejected.body.estimate.status).toBe('rejected');
  });

  it('ignores any status the client tries to send', async () => {
    const result = await call(sendAction, EST_A, { status: 'accepted', from: 'sent' });
    expect(result.status).toBe(200);
    expect(currentStatus()).toBe('sent');
  });

  it('rejects draft -> accepted and draft -> rejected with 409', async () => {
    for (const handler of [acceptAction, rejectAction]) {
      mockState.client = createBackend('draft');
      clearPermissionCache();

      const result = await call(handler, EST_A);
      expect(result.status).toBe(409);
      expect(result.body.code).toBe('ESTIMATE_CONFLICT');
      expect(currentStatus()).toBe('draft');
    }
  });

  it('treats accepted and rejected as terminal', async () => {
    for (const status of ['accepted', 'rejected']) {
      for (const handler of [sendAction, acceptAction, rejectAction]) {
        mockState.client = createBackend(status);
        clearPermissionCache();

        const result = await call(handler, EST_A);
        expect(result.status).toBe(409);
        expect(currentStatus()).toBe(status);
      }
    }
  });

  it('rejects a transition that races with another writer', async () => {
    mockState.client = createBackend('draft', {
      before: (table, action) => {
        if (table === 'estimates' && action === 'update') {
          // Someone else moved the estimate first.
          (mockState.client.tables.estimates as Row[]).find((e) => e.id === EST_A)!.status = 'sent';
        }
      },
    });

    const result = await call(sendAction, EST_A);
    expect(result.status).toBe(409);
    expect(result.body.error).toMatch(/concurrently/);
  });
});

describe('lifecycle guards', () => {
  it('requires the action-specific permission', async () => {
    mockState.profile = sender; // may send, may not accept
    expect((await call(sendAction, EST_A)).status).toBe(200);

    mockState.client = createBackend('sent');
    clearPermissionCache();
    expect((await call(acceptAction, EST_A)).status).toBe(403);
    expect(currentStatus()).toBe('sent');
  });

  it('returns 403 for callers without the required permission', async () => {
    mockState.profile = viewer;
    const result = await call(sendAction, EST_A);
    expect(result.status).toBe(403);
    expect(currentStatus()).toBe('draft');
  });

  it('never changes another account\'s estimate', async () => {
    // manager is an account-A member with every permission; B is foreign.
    const result = await call(sendAction, EST_B);

    expect(result.status).toBe(404);
    expect(result.body).toEqual({ error: 'Estimate not found' });
    expect((mockState.client.tables.estimates as Row[]).find((e) => e.id === EST_B)!.status).toBe(
      'sent',
    );
  });

  it('returns 404 for a missing estimate', async () => {
    const result = await call(sendAction, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc');
    expect(result.status).toBe(404);
  });

  it('returns 400 for a malformed id', async () => {
    expect((await call(sendAction, 'not-a-uuid')).status).toBe(400);
  });

  it('returns 401 when unauthenticated and 500 without a client', async () => {
    mockState.profile = null;
    expect((await call(sendAction, EST_A)).status).toBe(401);

    mockState.profile = manager;
    mockState.client = null;
    expect((await call(sendAction, EST_A)).status).toBe(500);
  });
});

describe('no hard delete', () => {
  it('exposes only POST on the action routes', () => {
    for (const module of [sendModule, acceptModule, rejectModule]) {
      expect((module as Row).POST).toBeTypeOf('function');
      expect((module as Row).DELETE).toBeUndefined();
      expect((module as Row).GET).toBeUndefined();
      expect((module as Row).PATCH).toBeUndefined();
    }
  });
});
