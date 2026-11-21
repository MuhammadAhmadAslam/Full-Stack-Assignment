/**
 * Idempotency — keys, fingerprints and duplicate-creation behaviour.
 *
 * The fake `rpc` below implements the same arbitration the SQL function
 * performs: check-and-insert happens synchronously after a single await,
 * so concurrent callers behave exactly like transactions racing on a
 * unique index (one winner, everyone else replays).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  computeRequestFingerprint,
  isIdempotencyKeyValid,
  normalizeIdempotencyKey,
  readIdempotencyKeyHeader,
  stableStringify,
  IdempotencyKeyError,
  IDEMPOTENCY_RETENTION_DAYS,
} from '@/lib/idempotency';
import { estimateService, EstimateConflictError, EstimateDatabaseError } from '@/lib/estimate-service';
import { clearPermissionCache } from '@/lib/permission-checker';
import { PermissionError } from '@/lib/server-guards';
import type { UserWithRoles } from '@/lib/rbac-types';

// ---------------------------------------------------------------------------
// Fake backend: membership reads + the idempotent RPC
// ---------------------------------------------------------------------------
type Row = Record<string, any>;

function profile(id: string, permissions: Record<string, boolean>): UserWithRoles {
  return {
    id,
    is_superadmin: false,
    user_roles: [
      { role_id: 'role-1', roles: { id: 'role-1', name: 'Test', is_system_role: false, permissions } },
    ],
  } as unknown as UserWithRoles;
}

const ALL_PERMISSIONS = {
  view_estimates: true,
  create_estimates: true,
  update_estimates: true,
  send_estimates: true,
  accept_estimates: true,
  reject_estimates: true,
};

const manager = profile('user-manager', ALL_PERMISSIONS);
const viewer = profile('user-viewer', { view_estimates: true });

function createIdempotentBackend() {
  const keys = new Map<string, { hash: string; body: any; status: number; estimateId: string }>();
  const estimates: Row[] = [];
  const failures: Row[] = [];
  const rpcCalls: string[] = [];
  let seq = 0;

  const memberships = [
    { account_id: 'account-a', user_id: 'user-manager' },
    { account_id: 'account-b', user_id: 'user-manager' },
    { account_id: 'account-a', user_id: 'user-viewer' },
  ];

  const from = (table: string) => {
    const filters: Array<(row: Row) => boolean> = [];
    const rowsFor = () => {
      if (table === 'account_members') {
        return memberships.map((m, i) => ({ id: `m-${i}`, removed_at: null, ...m }));
      }
      return [];
    };
    const chain: any = {
      select: () => chain,
      eq: (col: string, val: any) => {
        filters.push((row) => row[col] === val);
        return chain;
      },
      is: (col: string, val: any) => {
        filters.push((row) => (row[col] ?? null) === val);
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

    // Yield once so concurrent callers interleave *before* the atomic step.
    await Promise.resolve();

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

    const lineItems = (params.p_lines ?? []).map((line: Row, i: number) => ({
      id: `line-${seq}-${i}`,
      estimate_id: estimate.id,
      description: line.description,
      quantity: line.quantity,
      unit_price_minor: line.unit_price_minor,
      amount_minor: Math.round(Number(line.quantity) * line.unit_price_minor),
      sort_order: line.sort_order ?? i,
      created_at: '2026-01-01T00:00:00.000Z',
    }));

    const body = { estimate, lineItems };
    keys.set(scope, { hash: params.p_request_hash, body, status: 201, estimateId: estimate.id });
    estimates.push(estimate);

    return {
      data: [{ outcome: 'created', response_status: 201, response_body: body, estimate_id: estimate.id }],
      error: null,
    };
  };

  return { from, rpc, estimates, keys, rpcCalls, failNext: (error: Row) => failures.push(error) };
}

const baseInput = {
  account_id: 'account-a',
  estimate_number: 'EST-500',
  title: 'Idempotent estimate',
  currency: 'USD',
  line_items: [{ description: 'Design', quantity: '1.5', unit_price_minor: 20_000 }],
  tax_rate_bps: 1000,
};

const KEY = 'idem-key-0001';

beforeEach(() => clearPermissionCache());

// ---------------------------------------------------------------------------
// Key handling
// ---------------------------------------------------------------------------
describe('idempotency keys', () => {
  it('accepts UUID/ULID-style keys and trims whitespace', () => {
    expect(normalizeIdempotencyKey('  550e8400-e29b-41d4-a716-446655440000  ')).toBe(
      '550e8400-e29b-41d4-a716-446655440000',
    );
    expect(normalizeIdempotencyKey('01H8XGJWBWBAQ4PZ9K5N6M7T8R')).toBe('01H8XGJWBWBAQ4PZ9K5N6M7T8R');
    expect(isIdempotencyKeyValid('order_1234:attempt-1')).toBe(true);
  });

  it('treats missing or blank keys as absent', () => {
    expect(normalizeIdempotencyKey(null)).toBeNull();
    expect(normalizeIdempotencyKey(undefined)).toBeNull();
    expect(normalizeIdempotencyKey('   ')).toBeNull();
  });

  it('rejects malformed keys', () => {
    for (const bad of ['short', 'has space here', 'has/slash/1234', 'a'.repeat(256), 'emoji-🔑-1234']) {
      expect(() => normalizeIdempotencyKey(bad), bad).toThrow(IdempotencyKeyError);
    }
  });

  it('reads the header case-insensitively through Headers', () => {
    const headers = new Headers({ 'Idempotency-Key': KEY });
    expect(readIdempotencyKeyHeader({ headers })).toBe(KEY);
    expect(readIdempotencyKeyHeader(null)).toBeNull();
  });

  it('documents a 30-day retention window', () => {
    expect(IDEMPOTENCY_RETENTION_DAYS).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// Fingerprints
// ---------------------------------------------------------------------------
describe('request fingerprints', () => {
  it('is stable across property order', () => {
    const a = computeRequestFingerprint({ b: 2, a: 1, nested: { y: 2, x: 1 } });
    const b = computeRequestFingerprint({ nested: { x: 1, y: 2 }, a: 1, b: 2 });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when a value changes and preserves array order', () => {
    const base = { lines: [1, 2], total: 100 };
    expect(computeRequestFingerprint(base)).not.toBe(computeRequestFingerprint({ ...base, total: 101 }));
    expect(computeRequestFingerprint(base)).not.toBe(
      computeRequestFingerprint({ lines: [2, 1], total: 100 }),
    );
  });

  it('distinguishes types and handles nested structures', () => {
    expect(computeRequestFingerprint({ v: '1' })).not.toBe(computeRequestFingerprint({ v: 1 }));
    expect(stableStringify({ z: undefined, a: [1, { c: null, b: true }] })).toBe(
      '{"a":[1,{"b":true,"c":null}]}',
    );
  });
});

// ---------------------------------------------------------------------------
// Creation behaviour
// ---------------------------------------------------------------------------
describe('createEstimateIdempotent', () => {
  it('creates once for the same key repeated 10 times', async () => {
    const db = createIdempotentBackend();
    const results = [];

    for (let i = 0; i < 10; i++) {
      results.push(await estimateService.createEstimateIdempotent(baseInput, manager, KEY, db as any));
    }

    expect(db.estimates).toHaveLength(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(results.filter((r) => r.replayed)).toHaveLength(9);
    expect(new Set(results.map((r) => r.estimate.id)).size).toBe(1);
    // The replay returns the original totals, not a recomputation.
    expect(results[9].estimate.total_minor).toBe(33_000);
  });

  it('creates once under concurrent same-key requests', async () => {
    const db = createIdempotentBackend();

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        estimateService.createEstimateIdempotent(baseInput, manager, KEY, db as any),
      ),
    );

    expect(db.estimates).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'created')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'replay')).toHaveLength(4);
    expect(new Set(results.map((r) => r.estimate.id)).size).toBe(1);
  });

  it('treats different keys as independent creations', async () => {
    const db = createIdempotentBackend();

    const first = await estimateService.createEstimateIdempotent(baseInput, manager, 'idem-key-aaaa', db as any);
    const second = await estimateService.createEstimateIdempotent(baseInput, manager, 'idem-key-bbbb', db as any);

    expect(db.estimates).toHaveLength(2);
    expect(first.estimate.id).not.toBe(second.estimate.id);
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(false);
  });

  it('rejects a reused key with a different payload', async () => {
    const db = createIdempotentBackend();

    await estimateService.createEstimateIdempotent(baseInput, manager, KEY, db as any);

    await expect(
      estimateService.createEstimateIdempotent(
        { ...baseInput, line_items: [{ description: 'Design', quantity: '2', unit_price_minor: 20_000 }] },
        manager,
        KEY,
        db as any,
      ),
    ).rejects.toThrow(EstimateConflictError);

    expect(db.estimates).toHaveLength(1);
    expect(db.estimates[0].total_minor).toBe(33_000);
  });

  it('scopes keys per account', async () => {
    const db = createIdempotentBackend();

    const first = await estimateService.createEstimateIdempotent(baseInput, manager, KEY, db as any);
    const second = await estimateService.createEstimateIdempotent(
      { ...baseInput, account_id: 'account-b' },
      manager,
      KEY,
      db as any,
    );

    expect(db.estimates).toHaveLength(2);
    expect(first.estimate.account_id).toBe('account-a');
    expect(second.estimate.account_id).toBe('account-b');
  });

  it('normalises equivalent payloads so they replay instead of conflicting', async () => {
    const db = createIdempotentBackend();

    const first = await estimateService.createEstimateIdempotent(
      { ...baseInput, currency: 'usd', line_items: [{ description: 'Design', quantity: 1.5, unit_price_minor: 20_000 }] },
      manager,
      KEY,
      db as any,
    );
    const second = await estimateService.createEstimateIdempotent(
      { ...baseInput, currency: 'USD', line_items: [{ description: 'Design', quantity: '1.500', unit_price_minor: 20_000 }] },
      manager,
      KEY,
      db as any,
    );

    expect(db.estimates).toHaveLength(1);
    expect(second.replayed).toBe(true);
    expect(second.estimate.id).toBe(first.estimate.id);
  });

  it('leaves no key behind when creation fails, so a retry succeeds', async () => {
    const db = createIdempotentBackend();
    db.failNext({ code: '40001', message: 'could not serialize access' });

    await expect(
      estimateService.createEstimateIdempotent(baseInput, manager, KEY, db as any),
    ).rejects.toThrow(EstimateDatabaseError);

    expect(db.estimates).toHaveLength(0);
    expect(db.keys.size).toBe(0);

    const retry = await estimateService.createEstimateIdempotent(baseInput, manager, KEY, db as any);
    expect(retry.outcome).toBe('created');
    expect(db.estimates).toHaveLength(1);
  });

  it('requires a key', async () => {
    const db = createIdempotentBackend();
    await expect(
      estimateService.createEstimateIdempotent(baseInput, manager, null, db as any),
    ).rejects.toThrow(IdempotencyKeyError);
    await expect(
      estimateService.createEstimateIdempotent(baseInput, manager, 'bad key!', db as any),
    ).rejects.toThrow(IdempotencyKeyError);
    expect(db.rpcCalls).toHaveLength(0);
  });

  it('enforces the financial permission before touching the key table', async () => {
    const db = createIdempotentBackend();
    await expect(
      estimateService.createEstimateIdempotent(baseInput, viewer, KEY, db as any),
    ).rejects.toThrow(PermissionError);
    expect(db.rpcCalls).toHaveLength(0);
    expect(db.estimates).toHaveLength(0);
  });

  it('sends canonical quantity strings to the database (never floats)', async () => {
    const db = createIdempotentBackend();
    let captured: Row | null = null;
    const originalRpc = db.rpc;
    (db as any).rpc = async (name: string, params: Row) => {
      captured = params;
      return originalRpc(name, params);
    };

    await estimateService.createEstimateIdempotent(
      { ...baseInput, line_items: [{ description: 'Design', quantity: 1.5, unit_price_minor: 20_000 }] },
      manager,
      KEY,
      db as any,
    );

    expect(captured!.p_lines).toEqual([
      { description: 'Design', quantity: '1.500', unit_price_minor: 20_000, sort_order: 0 },
    ]);
    expect(typeof captured!.p_subtotal_minor).toBe('number');
  });
});
