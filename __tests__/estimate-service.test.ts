/**
 * Estimate domain service — business rules in one testable layer.
 *
 * Everything runs against an in-memory Supabase stub (writes included), so
 * lifecycle, tenancy, totals, immutability and concurrency are exercised
 * without a database.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  estimateService,
  canTransition,
  assertTransition,
  isEstimateEditable,
  ESTIMATE_STATUS_TRANSITIONS,
  EstimateNotFoundError,
  EstimateValidationError,
  EstimateConflictError,
  EstimateDatabaseError,
} from '@/lib/estimate-service';
import { clearPermissionCache } from '@/lib/permission-checker';
import { PermissionError } from '@/lib/server-guards';
import type { UserWithRoles } from '@/lib/rbac-types';

// ---------------------------------------------------------------------------
// In-memory Supabase stub (select / insert / update / delete)
// ---------------------------------------------------------------------------
type Row = Record<string, any>;

interface FakeOptions {
  /** Runs right before a write executes — used to simulate races. */
  before?: (table: string, action: string) => void;
}

function createFakeDb(seed: Record<string, Row[]> = {}, options: FakeOptions = {}) {
  const tables: Record<string, Row[]> = {};
  Object.entries(seed).forEach(([table, rows]) => {
    tables[table] = rows.map((row) => ({ ...row }));
  });

  const queued: Array<{ table: string; action: string; error: Row }> = [];
  let seq = 0;

  function failNext(
    table: string,
    action: 'insert' | 'update' | 'delete',
    error: Row = { code: 'XX000', message: 'simulated failure' },
  ) {
    queued.push({ table, action, error });
  }

  function takeFailure(table: string, action: string) {
    const index = queued.findIndex((q) => q.table === table && q.action === action);
    if (index === -1) return null;
    const [entry] = queued.splice(index, 1);
    return entry.error;
  }

  function from(table: string) {
    const filters: Array<(row: Row) => boolean> = [];
    let action: 'select' | 'insert' | 'update' | 'delete' = 'select';
    let payload: any = null;
    let range: [number, number] | null = null;

    const rows = () => (tables[table] ??= []);
    const matched = () => rows().filter((row) => filters.every((f) => f(row)));

    const execute = () => {
      if (action !== 'select') options.before?.(table, action);

      const failure = takeFailure(table, action);
      if (failure) return { data: null, error: failure, count: 0 };

      if (action === 'insert') {
        const items = (Array.isArray(payload) ? payload : [payload]).map((item: Row) => ({
          id: item.id ?? `${table}-${++seq}`,
          created_at: item.created_at ?? '2026-01-01T00:00:00.000Z',
          ...item,
        }));
        rows().push(...items);
        return { data: items.map((r) => ({ ...r })), error: null, count: items.length };
      }

      if (action === 'update') {
        const hits = matched();
        hits.forEach((row) => Object.assign(row, payload));
        return { data: hits.map((r) => ({ ...r })), error: null, count: hits.length };
      }

      if (action === 'delete') {
        const hits = matched();
        tables[table] = rows().filter((row) => !hits.includes(row));
        return { data: null, error: null, count: hits.length };
      }

      const filtered = matched()
        .slice()
        .sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')));
      const paged = range ? filtered.slice(range[0], range[1] + 1) : filtered;
      return { data: paged.map((r) => ({ ...r })), error: null, count: filtered.length };
    };

    const toList = (result: ReturnType<typeof execute>) => {
      if (Array.isArray(result.data)) return result.data;
      return result.data ? [result.data] : [];
    };

    const chain: any = {
      select: () => chain,
      insert: (value: any) => {
        action = 'insert';
        payload = value;
        return chain;
      },
      update: (value: any) => {
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
      in: (column: string, values: any[]) => {
        filters.push((row) => values.includes(row[column]));
        return chain;
      },
      limit: () => chain,
      order: () => chain,
      range: (start: number, end: number) => {
        range = [start, end];
        return chain;
      },
      maybeSingle: () => {
        const result = execute();
        return Promise.resolve({ data: toList(result)[0] ?? null, error: result.error });
      },
      single: () => {
        const result = execute();
        const first = toList(result)[0] ?? null;
        return Promise.resolve({
          data: first,
          error: result.error ?? (first ? null : { code: 'PGRST116', message: 'no rows' }),
        });
      },
      then: (onFulfilled: any, onRejected: any) =>
        Promise.resolve(execute()).then(onFulfilled, onRejected),
    };

    return chain;
  }

  return { from, tables, failNext };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const ACCOUNT_A = 'account-a';
const ACCOUNT_B = 'account-b';

const ALL_ESTIMATE_PERMISSIONS: Record<string, boolean> = {
  view_estimates: true,
  create_estimates: true,
  update_estimates: true,
  send_estimates: true,
  accept_estimates: true,
  reject_estimates: true,
};

function profile(
  id: string,
  permissions: Record<string, boolean>,
  opts: { isSuperadmin?: boolean } = {},
): UserWithRoles {
  return {
    id,
    is_superadmin: opts.isSuperadmin ?? false,
    user_roles: [
      {
        role_id: 'role-1',
        roles: {
          id: 'role-1',
          name: 'Test Role',
          is_system_role: false,
          permissions,
        },
      },
    ],
  } as unknown as UserWithRoles;
}

const manager = profile('user-manager', ALL_ESTIMATE_PERMISSIONS);
const viewer = profile('user-viewer', { view_estimates: true });
const outsider = profile('user-outsider', ALL_ESTIMATE_PERMISSIONS);
const nobody = profile('user-nobody', {});

function baseSeed() {
  return {
    accounts: [{ id: ACCOUNT_A, account_manager_id: null }, { id: ACCOUNT_B }],
    account_members: [
      { id: 'm-1', account_id: ACCOUNT_A, user_id: 'user-manager', removed_at: null },
      { id: 'm-2', account_id: ACCOUNT_A, user_id: 'user-viewer', removed_at: null },
      { id: 'm-3', account_id: ACCOUNT_A, user_id: 'user-nobody', removed_at: null },
      { id: 'm-4', account_id: ACCOUNT_B, user_id: 'user-outsider', removed_at: null },
    ],
    projects: [
      { id: 'proj-a', account_id: ACCOUNT_A, name: 'Project A' },
      { id: 'proj-b', account_id: ACCOUNT_B, name: 'Project B' },
    ],
    estimates: [] as Row[],
    estimate_line_items: [] as Row[],
  };
}

function estimateRow(overrides: Row = {}): Row {
  return {
    id: 'est-1',
    account_id: ACCOUNT_A,
    project_id: null,
    estimate_number: 'EST-001',
    title: 'Seeded estimate',
    description: null,
    status: 'draft',
    currency: 'USD',
    subtotal_minor: 100_000,
    tax_minor: 0,
    total_minor: 100_000,
    created_by: 'user-manager',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function lineRow(overrides: Row = {}): Row {
  return {
    id: `line-${Math.random().toString(16).slice(2)}`,
    estimate_id: 'est-1',
    description: 'Seeded line',
    quantity: '1.000',
    unit_price_minor: 100_000,
    amount_minor: 100_000,
    sort_order: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const createInput = {
  account_id: ACCOUNT_A,
  estimate_number: 'EST-100',
  title: 'Website redesign',
  currency: 'usd',
  line_items: [
    { description: 'Discovery', quantity: '2.5', unit_price_minor: 12_000 },
    { description: 'Build', quantity: 3, unit_price_minor: 45_000, sort_order: 1 },
  ],
  tax_rate_bps: 825,
};

beforeEach(() => clearPermissionCache());

// ---------------------------------------------------------------------------
// Lifecycle table
// ---------------------------------------------------------------------------
describe('lifecycle rules', () => {
  it('allows only the defined transitions', () => {
    expect(canTransition('draft', 'sent')).toBe(true);
    expect(canTransition('sent', 'accepted')).toBe(true);
    expect(canTransition('sent', 'rejected')).toBe(true);

    expect(canTransition('draft', 'accepted')).toBe(false);
    expect(canTransition('draft', 'rejected')).toBe(false);
    expect(canTransition('accepted', 'sent')).toBe(false);
    expect(canTransition('rejected', 'accepted')).toBe(false);
    expect(canTransition('accepted', 'rejected')).toBe(false);
  });

  it('treats accepted and rejected as terminal', () => {
    expect(ESTIMATE_STATUS_TRANSITIONS.accepted).toEqual([]);
    expect(ESTIMATE_STATUS_TRANSITIONS.rejected).toEqual([]);
  });

  it('throws a conflict on an invalid transition', () => {
    expect(() => assertTransition('draft', 'accepted')).toThrow(EstimateConflictError);
    expect(() => assertTransition('sent', 'draft')).toThrow(EstimateConflictError);
  });

  it('lets only drafts be edited', () => {
    expect(isEstimateEditable('draft')).toBe(true);
    expect(isEstimateEditable('sent')).toBe(false);
    expect(isEstimateEditable('accepted')).toBe(false);
    expect(isEstimateEditable('rejected')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------
describe('createEstimate', () => {
  it('creates a draft with server-calculated totals', async () => {
    const db = createFakeDb(baseSeed());

    const result = await estimateService.createEstimate(createInput, manager, db as any);

    expect(result.estimate.status).toBe('draft');
    expect(result.estimate.currency).toBe('USD'); // normalised
    expect(result.estimate.created_by).toBe('user-manager');
    expect(result.estimate.subtotal_minor).toBe(165_000);
    expect(result.estimate.tax_minor).toBe(13_613);
    expect(result.estimate.total_minor).toBe(178_613);

    expect(db.tables.estimates).toHaveLength(1);
    expect(db.tables.estimate_line_items).toHaveLength(2);
    expect(db.tables.estimate_line_items.map((l) => l.quantity)).toEqual(['2.500', '3.000']);
    // amount_minor is a generated column — the service must never send it.
    expect(db.tables.estimate_line_items[0]).not.toHaveProperty('amount_minor');
  });

  it('rejects creation in an account the user does not belong to', async () => {
    const db = createFakeDb(baseSeed());

    await expect(
      estimateService.createEstimate(createInput, outsider, db as any),
    ).rejects.toThrow(PermissionError);

    expect(db.tables.estimates).toHaveLength(0);
  });

  it('rejects creating without the financial permission', async () => {
    const db = createFakeDb(baseSeed());

    await expect(estimateService.createEstimate(createInput, nobody, db as any)).rejects.toThrow(
      PermissionError,
    );
    expect(db.tables.estimates).toHaveLength(0);
  });

  it('rejects a project that belongs to another account', async () => {
    const db = createFakeDb(baseSeed());

    await expect(
      estimateService.createEstimate(
        { ...createInput, project_id: 'proj-b' },
        manager,
        db as any,
      ),
    ).rejects.toThrow(EstimateValidationError);

    expect(db.tables.estimates).toHaveLength(0);
  });

  it('accepts a project from the same account', async () => {
    const db = createFakeDb(baseSeed());

    const result = await estimateService.createEstimate(
      { ...createInput, project_id: 'proj-a' },
      manager,
      db as any,
    );

    expect(result.estimate.project_id).toBe('proj-a');
  });

  it('maps a duplicate estimate number to a conflict', async () => {
    const db = createFakeDb(baseSeed());
    db.failNext('estimates', 'insert', {
      code: '23505',
      message: 'duplicate key value violates unique constraint',
    });

    await expect(estimateService.createEstimate(createInput, manager, db as any)).rejects.toThrow(
      EstimateConflictError,
    );
  });

  it('rolls the estimate back when line items fail', async () => {
    const db = createFakeDb(baseSeed());
    db.failNext('estimate_line_items', 'insert');

    await expect(estimateService.createEstimate(createInput, manager, db as any)).rejects.toThrow(
      EstimateDatabaseError,
    );

    expect(db.tables.estimates).toHaveLength(0);
    expect(db.tables.estimate_line_items).toHaveLength(0);
  });

  it('rejects invalid money before touching the database', async () => {
    const db = createFakeDb(baseSeed());

    await expect(
      estimateService.createEstimate(
        {
          ...createInput,
          line_items: [{ description: 'Bad', quantity: '1.2345', unit_price_minor: 100 }],
        },
        manager,
        db as any,
      ),
    ).rejects.toThrow(EstimateValidationError);

    expect(db.tables.estimates).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------
describe('reads', () => {
  it('returns the estimate with lines ordered by sort_order', async () => {
    const db = createFakeDb({
      ...baseSeed(),
      estimates: [estimateRow()],
      estimate_line_items: [
        lineRow({ id: 'l-2', sort_order: 1, description: 'Second' }),
        lineRow({ id: 'l-1', sort_order: 0, description: 'First' }),
      ],
    });

    const result = await estimateService.getEstimate('est-1', viewer, db as any);
    expect(result.lineItems.map((l) => l.description)).toEqual(['First', 'Second']);
  });

  it('throws not-found for an unknown id', async () => {
    const db = createFakeDb(baseSeed());
    await expect(estimateService.getEstimate('missing', manager, db as any)).rejects.toThrow(
      EstimateNotFoundError,
    );
  });

  it('blocks reading another account\'s estimate even with permissions', async () => {
    const db = createFakeDb({ ...baseSeed(), estimates: [estimateRow()] });
    // Another tenant's row is reported as missing, not as forbidden.
    await expect(estimateService.getEstimate('est-1', outsider, db as any)).rejects.toThrow(
      EstimateNotFoundError,
    );
  });

  it('lists only the requested account with a page size cap', async () => {
    const db = createFakeDb({
      ...baseSeed(),
      estimates: [
        estimateRow({ id: 'est-1' }),
        estimateRow({ id: 'est-2', estimate_number: 'EST-002' }),
        estimateRow({ id: 'est-9', account_id: ACCOUNT_B }),
      ],
    });

    const result = await estimateService.listEstimates(
      { accountId: ACCOUNT_A, limit: 500 },
      viewer,
      db as any,
    );

    expect(result.estimates.map((e) => e.id).sort()).toEqual(['est-1', 'est-2']);
    expect(result.count).toBe(2);
    expect(result.limit).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Updates (draft only)
// ---------------------------------------------------------------------------
describe('updateEstimate', () => {
  it('replaces line items and recalculates totals on a draft', async () => {
    const db = createFakeDb({
      ...baseSeed(),
      estimates: [estimateRow()],
      estimate_line_items: [lineRow({ id: 'old-line' })],
    });

    const result = await estimateService.updateEstimate(
      'est-1',
      { line_items: [{ description: 'New work', quantity: '1.5', unit_price_minor: 20_000 }] },
      manager,
      db as any,
    );

    expect(result.estimate.subtotal_minor).toBe(30_000);
    expect(result.lineItems).toHaveLength(1);
    expect(result.lineItems[0].description).toBe('New work');
    expect(db.tables.estimate_line_items.map((l) => l.description)).toEqual(['New work']);
  });

  it('recalculates tax from the stored lines when only tax changes', async () => {
    const db = createFakeDb({
      ...baseSeed(),
      estimates: [estimateRow()],
      estimate_line_items: [lineRow({ quantity: '2.000', unit_price_minor: 50_000 })],
    });

    const result = await estimateService.updateEstimate(
      'est-1',
      { tax_rate_bps: 1000 },
      manager,
      db as any,
    );

    expect(result.estimate.subtotal_minor).toBe(100_000);
    expect(result.estimate.tax_minor).toBe(10_000);
    expect(result.estimate.total_minor).toBe(110_000);
  });

  it('refuses to modify a sent estimate or its line items', async () => {
    const db = createFakeDb({
      ...baseSeed(),
      estimates: [estimateRow({ status: 'sent' })],
      estimate_line_items: [lineRow({ id: 'keep-me' })],
    });

    await expect(
      estimateService.updateEstimate('est-1', { title: 'Sneaky rename' }, manager, db as any),
    ).rejects.toThrow(EstimateConflictError);

    expect(db.tables.estimates[0].title).toBe('Seeded estimate');
    expect(db.tables.estimate_line_items).toHaveLength(1);
    expect(db.tables.estimate_line_items[0].description).toBe('Seeded line');
  });

  it('refuses to modify accepted and rejected estimates', async () => {
    for (const status of ['accepted', 'rejected']) {
      const db = createFakeDb({ ...baseSeed(), estimates: [estimateRow({ status })] });
      await expect(
        estimateService.updateEstimate('est-1', { title: 'Nope' }, manager, db as any),
      ).rejects.toThrow(EstimateConflictError);
    }
  });

  it('reports a conflict when the estimate stops being a draft mid-update', async () => {
    const db = createFakeDb(
      { ...baseSeed(), estimates: [estimateRow()] },
      {
        before: (table, action) => {
          if (table === 'estimates' && action === 'update') {
            db.tables.estimates[0].status = 'sent';
          }
        },
      },
    );

    await expect(
      estimateService.updateEstimate('est-1', { title: 'Too late' }, manager, db as any),
    ).rejects.toThrow(/concurrently/);
  });

  it('requires the update permission', async () => {
    const db = createFakeDb({ ...baseSeed(), estimates: [estimateRow()] });
    await expect(
      estimateService.updateEstimate('est-1', { title: 'X' }, viewer, db as any),
    ).rejects.toThrow(PermissionError);
  });

  it('restores totals when the new line items cannot be saved', async () => {
    const db = createFakeDb({
      ...baseSeed(),
      estimates: [estimateRow()],
      estimate_line_items: [lineRow({ id: 'old-line' })],
    });
    db.failNext('estimate_line_items', 'insert');

    await expect(
      estimateService.updateEstimate(
        'est-1',
        { line_items: [{ description: 'New', quantity: 1, unit_price_minor: 999 }] },
        manager,
        db as any,
      ),
    ).rejects.toThrow(EstimateDatabaseError);

    // Header totals are rolled back and the previous line is restored.
    expect(db.tables.estimates[0].subtotal_minor).toBe(100_000);
    expect(db.tables.estimates[0].total_minor).toBe(100_000);
    expect(db.tables.estimate_line_items).toHaveLength(1);
    expect(db.tables.estimate_line_items[0].description).toBe('Seeded line');
  });
});

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------
describe('status transitions', () => {
  it('sends a draft', async () => {
    const db = createFakeDb({ ...baseSeed(), estimates: [estimateRow()] });

    const updated = await estimateService.sendEstimate('est-1', manager, db as any);
    expect(updated.status).toBe('sent');
    expect(db.tables.estimates[0].status).toBe('sent');
  });

  it('accepts and rejects a sent estimate', async () => {
    const acceptDb = createFakeDb({ ...baseSeed(), estimates: [estimateRow({ status: 'sent' })] });
    expect((await estimateService.acceptEstimate('est-1', manager, acceptDb as any)).status).toBe(
      'accepted',
    );

    const rejectDb = createFakeDb({ ...baseSeed(), estimates: [estimateRow({ status: 'sent' })] });
    expect((await estimateService.rejectEstimate('est-1', manager, rejectDb as any)).status).toBe(
      'rejected',
    );
  });

  it('rejects draft -> accepted and draft -> rejected', async () => {
    for (const call of ['acceptEstimate', 'rejectEstimate'] as const) {
      const db = createFakeDb({ ...baseSeed(), estimates: [estimateRow()] });
      await expect((estimateService[call] as any)('est-1', manager, db)).rejects.toThrow(
        EstimateConflictError,
      );
      expect(db.tables.estimates[0].status).toBe('draft');
    }
  });

  it('keeps accepted and rejected terminal', async () => {
    for (const status of ['accepted', 'rejected']) {
      for (const call of ['sendEstimate', 'acceptEstimate', 'rejectEstimate'] as const) {
        const db = createFakeDb({ ...baseSeed(), estimates: [estimateRow({ status })] });
        await expect((estimateService[call] as any)('est-1', manager, db)).rejects.toThrow(
          EstimateConflictError,
        );
        expect(db.tables.estimates[0].status).toBe(status);
      }
    }
  });

  it('enforces one permission per transition', async () => {
    const db = createFakeDb({ ...baseSeed(), estimates: [estimateRow()] });
    await expect(estimateService.sendEstimate('est-1', viewer, db as any)).rejects.toThrow(
      PermissionError,
    );
    expect(db.tables.estimates[0].status).toBe('draft');
  });

  it('reports a conflict when the status changes concurrently', async () => {
    const db = createFakeDb(
      { ...baseSeed(), estimates: [estimateRow()] },
      {
        before: (table, action) => {
          if (table === 'estimates' && action === 'update') {
            db.tables.estimates[0].status = 'sent';
          }
        },
      },
    );

    await expect(estimateService.sendEstimate('est-1', manager, db as any)).rejects.toThrow(
      /concurrently/,
    );
  });

  it('throws not-found for an unknown estimate', async () => {
    const db = createFakeDb(baseSeed());
    await expect(estimateService.sendEstimate('missing', manager, db as any)).rejects.toThrow(
      EstimateNotFoundError,
    );
  });
});

// ---------------------------------------------------------------------------
// No hard deletes
// ---------------------------------------------------------------------------
describe('deletion policy', () => {
  it('exposes no delete operation', () => {
    const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(estimateService));
    expect(surface.filter((name) => /delete|destroy|remove/i.test(name))).toEqual([]);
    expect((estimateService as any).deleteEstimate).toBeUndefined();
  });
});
