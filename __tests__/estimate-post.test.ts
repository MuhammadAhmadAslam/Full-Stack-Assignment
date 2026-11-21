/**
 * POST /api/estimates — draft creation contract.
 *
 * The handler, the service, the money layer, the schema and the idempotency
 * helpers are all real; only Supabase is replaced. The fake `rpc` mirrors the
 * SQL function: it claims the key, writes the estimate *and* its lines in one
 * step (so there is no interleaving point), and arbitrates duplicates by
 * key+hash.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { clearPermissionCache } from '@/lib/permission-checker';
import type { UserWithRoles } from '@/lib/rbac-types';

type Row = Record<string, any>;

const ACCOUNT_A = '11111111-1111-1111-1111-111111111111';
const ACCOUNT_B = '22222222-2222-2222-2222-222222222222';
const PROJECT_A = '33333333-3333-3333-3333-333333333333';
const PROJECT_B = '44444444-4444-4444-4444-444444444444';
const KEY = 'post-idem-key-0001';

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
const viewer = profile('user-viewer', { view_estimates: true });
const outsider = profile('user-outsider', ALL);

function createBackend() {
  const keys = new Map<string, { hash: string; body: any; status: number; estimateId: string }>();
  const estimates: Row[] = [];
  const lineItems: Row[] = [];
  const failures: Row[] = [];
  const rpcCalls: string[] = [];
  let seq = 0;

  const memberships = [
    { id: 'm-1', account_id: ACCOUNT_A, user_id: 'user-manager', removed_at: null },
    { id: 'm-2', account_id: ACCOUNT_A, user_id: 'user-viewer', removed_at: null },
    { id: 'm-3', account_id: ACCOUNT_B, user_id: 'user-outsider', removed_at: null },
  ];
  const projects = [
    { id: PROJECT_A, account_id: ACCOUNT_A },
    { id: PROJECT_B, account_id: ACCOUNT_B },
  ];

  const from = (table: string) => {
    const filters: Array<(row: Row) => boolean> = [];
    const rowsFor = () => {
      if (table === 'account_members') return memberships;
      if (table === 'projects') return projects;
      return [];
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
      limit: () => chain,
      maybeSingle: () =>
        Promise.resolve({ data: rowsFor().filter((r) => filters.every((f) => f(r)))[0] ?? null, error: null }),
      then: (ok: any, ko: any) =>
        Promise.resolve({ data: rowsFor().filter((r) => filters.every((f) => f(r))), error: null }).then(ok, ko),
    };
    return chain;
  };

  const rpc = async (name: string, params: Row) => {
    rpcCalls.push(name);
    if (name !== 'create_estimate_idempotent') {
      return { data: null, error: { code: '42883', message: `unknown function ${name}` } };
    }

    await Promise.resolve(); // interleaving point, like the unique-index wait

    if (failures.length > 0) {
      return { data: null, error: failures.shift() };
    }

    const scope = `${params.p_account_id}::${params.p_idempotency_key}`;
    const existing = keys.get(scope);

    if (existing) {
      if (existing.hash !== params.p_request_hash) {
        return {
          data: [
            { outcome: 'conflict', response_status: 409, response_body: null, estimate_id: existing.estimateId },
          ],
          error: null,
        };
      }
      return {
        data: [
          {
            outcome: 'replay',
            response_status: existing.status,
            response_body: existing.body,
            estimate_id: existing.estimateId,
          },
        ],
        error: null,
      };
    }

    const estimate = {
      id: `est-${++seq}`,
      account_id: params.p_account_id,
      project_id: params.p_project_id,
      estimate_number: params.p_estimate_number,
      title: params.p_title,
      description: params.p_description,
      status: 'draft',
      currency: params.p_currency,
      subtotal_minor: params.p_subtotal_minor,
      tax_minor: params.p_tax_minor,
      total_minor: params.p_total_minor,
      created_by: 'user-manager',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    };

    const createdLines = (params.p_lines ?? []).map((line: Row, i: number) => ({
      id: `line-${seq}-${i}`,
      estimate_id: estimate.id,
      description: line.description,
      quantity: line.quantity,
      unit_price_minor: line.unit_price_minor,
      amount_minor: Math.round(Number(line.quantity) * line.unit_price_minor),
      sort_order: line.sort_order ?? i,
      created_at: '2026-01-01T00:00:00.000Z',
    }));

    // Estimate + lines are committed together, as in the SQL function.
    estimates.push(estimate);
    lineItems.push(...createdLines);

    const body = { estimate, lineItems: createdLines };
    keys.set(scope, { hash: params.p_request_hash, body, status: 201, estimateId: estimate.id });

    return {
      data: [{ outcome: 'created', response_status: 201, response_body: body, estimate_id: estimate.id }],
      error: null,
    };
  };

  return { from, rpc, estimates, lineItems, keys, rpcCalls, failNext: (error: Row) => failures.push(error) };
}

// ---------------------------------------------------------------------------
// Route harness
// ---------------------------------------------------------------------------
const mockState = vi.hoisted(() => ({ client: null as any, profile: null as any }));

vi.mock('@/lib/supabase-server', () => ({
  createApiSupabaseClient: () => mockState.client,
  getUserProfileFromRequest: async () => mockState.profile,
}));

import { POST } from '@/app/api/estimates/route';

const validPayload = {
  account_id: ACCOUNT_A,
  estimate_number: 'EST-900',
  title: 'Website redesign',
  currency: 'USD',
  line_items: [{ description: 'Discovery', quantity: '2.5', unit_price_minor: 12_000 }],
  tax_rate_bps: 1000,
};

async function post(body: unknown, headers: Record<string, string> = { 'Idempotency-Key': KEY }) {
  const request = new Request('http://localhost/api/estimates', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const response = await POST(request as any);
  return { status: response.status, body: await response.json() };
}

beforeEach(() => {
  clearPermissionCache();
  mockState.client = createBackend();
  mockState.profile = manager;
});

// ---------------------------------------------------------------------------
// Auth, key, schema
// ---------------------------------------------------------------------------
describe('POST /api/estimates — guards', () => {
  it('returns 500 when the database client is unavailable', async () => {
    mockState.client = null;
    expect((await post(validPayload)).status).toBe(500);
  });

  it('returns 401 for unauthenticated callers', async () => {
    mockState.profile = null;
    expect((await post(validPayload)).status).toBe(401);
  });

  it('requires the Idempotency-Key header', async () => {
    const result = await post(validPayload, {});
    expect(result.status).toBe(400);
    expect(result.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('rejects a malformed Idempotency-Key', async () => {
    const result = await post(validPayload, { 'Idempotency-Key': 'bad key!' });
    expect(result.status).toBe(400);
    expect(result.body.code).toBe('IDEMPOTENCY_KEY_INVALID');
  });

  it('rejects invalid JSON', async () => {
    const result = await post('{not json');
    expect(result.status).toBe(400);
    expect(result.body.code).toBe('INVALID_JSON');
  });

  it('rejects client-supplied totals', async () => {
    const result = await post({ ...validPayload, subtotal_minor: 1, total_minor: 1 });
    expect(result.status).toBe(400);
    expect(result.body.error).toBe('Invalid estimate payload');
  });

  it('rejects blank line descriptions and negative prices', async () => {
    const blank = await post({
      ...validPayload,
      line_items: [{ description: '   ', quantity: 1, unit_price_minor: 100 }],
    });
    expect(blank.status).toBe(400);

    const negative = await post({
      ...validPayload,
      line_items: [{ description: 'Work', quantity: 1, unit_price_minor: -500 }],
    });
    expect(negative.status).toBe(400);
  });

  it('rejects invalid currencies and over-precise quantities', async () => {
    expect((await post({ ...validPayload, currency: 'US' })).status).toBe(400);
    expect(
      (
        await post({
          ...validPayload,
          line_items: [{ description: 'Work', quantity: '1.2345', unit_price_minor: 100 }],
        })
      ).status,
    ).toBe(400);
  });

  it('rejects non-members and callers without create_estimates', async () => {
    mockState.profile = outsider;
    expect((await post(validPayload)).status).toBe(403);

    mockState.profile = viewer;
    const result = await post(validPayload);
    expect(result.status).toBe(403);
    expect((mockState.client as any).estimates).toHaveLength(0);
  });

  it('rejects a project owned by another account', async () => {
    const result = await post({ ...validPayload, project_id: PROJECT_B });
    expect(result.status).toBe(400);
    expect(result.body.error).toMatch(/aware|account/i);
    expect((mockState.client as any).estimates).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------
describe('POST /api/estimates — creation', () => {
  it('creates a draft with server-calculated totals', async () => {
    const result = await post(validPayload);

    expect(result.status).toBe(201);
    expect(result.body.success).toBe(true);
    expect(result.body.replayed).toBe(false);
    expect(result.body.estimate).toMatchObject({
      status: 'draft',
      currency: 'USD',
      subtotal_minor: 30_000,
      tax_minor: 3000,
      total_minor: 33_000,
    });
    expect(result.body.line_items).toHaveLength(1);
    expect(result.body.line_items[0]).toMatchObject({
      description: 'Discovery',
      quantity: '2.500',
      amount_minor: 30_000,
    });
  });

  it('normalises the currency and stores a same-account project', async () => {
    const result = await post({ ...validPayload, currency: 'usd', project_id: PROJECT_A });
    expect(result.status).toBe(201);
    expect(result.body.estimate).toMatchObject({ currency: 'USD', project_id: PROJECT_A });
  });

  it('saves the estimate and its lines in one atomic call', async () => {
    const backend: any = mockState.client;
    const result = await post(validPayload);

    expect(result.status).toBe(201);
    expect(backend.rpcCalls).toEqual(['create_estimate_idempotent']);
    expect(backend.estimates).toHaveLength(1);
    expect(backend.lineItems).toHaveLength(1);
    expect(backend.lineItems[0].estimate_id).toBe(backend.estimates[0].id);
  });

  it('replays the original response for a repeated key', async () => {
    const first = await post(validPayload);
    const second = await post(validPayload);

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.replayed).toBe(true);
    expect(second.body.estimate.id).toBe(first.body.estimate.id);
    expect((mockState.client as any).estimates).toHaveLength(1);
  });

  it('creates only one estimate across ten retries', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) {
      statuses.push((await post(validPayload)).status);
    }

    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 200)).toHaveLength(9);
    expect((mockState.client as any).estimates).toHaveLength(1);
  });

  it('returns 409 for the same key with a different payload', async () => {
    await post(validPayload);
    const conflict = await post({
      ...validPayload,
      line_items: [{ description: 'Discovery', quantity: '3', unit_price_minor: 12_000 }],
    });

    expect(conflict.status).toBe(409);
    expect((mockState.client as any).estimates).toHaveLength(1);
  });

  it('returns 409 for a duplicate estimate number', async () => {
    (mockState.client as any).failNext({
      code: '23505',
      message: 'duplicate key value violates unique constraint',
    });

    const result = await post(validPayload);
    expect(result.status).toBe(409);
    expect((mockState.client as any).estimates).toHaveLength(0);
  });

  it('leaves nothing behind on failure, so the retry creates exactly one estimate', async () => {
    (mockState.client as any).failNext({ code: '40001', message: 'could not serialize' });

    const failed = await post(validPayload);
    expect(failed.status).toBe(500);
    expect(failed.body.error).toBe('Database operation failed');
    expect(failed.body.details).toBeUndefined();
    expect((mockState.client as any).estimates).toHaveLength(0);
    expect((mockState.client as any).lineItems).toHaveLength(0);
    expect((mockState.client as any).keys.size).toBe(0);

    const retry = await post(validPayload);
    expect(retry.status).toBe(201);
    expect((mockState.client as any).estimates).toHaveLength(1);
  });
});
