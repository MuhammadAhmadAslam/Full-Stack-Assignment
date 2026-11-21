/**
 * Financial access guards — membership AND permission, independently enforced.
 *
 * These tests exercise the real implementation in lib/financial-access.ts
 * against an in-memory Supabase stub, so no network or database is needed.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  checkEstimateAccess,
  requireEstimatePermission,
  hasActiveAccountMembership,
  ESTIMATE_PERMISSIONS,
} from '@/lib/financial-access';
import { Permission } from '@/lib/permissions';
import { clearPermissionCache } from '@/lib/permission-checker';
import { AuthenticationError, PermissionError } from '@/lib/server-guards';
import type { UserWithRoles } from '@/lib/rbac-types';

// --- minimal Supabase query stub ------------------------------------------
type Row = Record<string, any>;

function stubSupabase(tables: Record<string, Row[]>) {
  const makeChain = (table: string) => {
    const filters: Array<(row: Row) => boolean> = [];
    const resolve = () => ({
      data: (tables[table] ?? []).filter((row) => filters.every((f) => f(row))),
      error: null,
    });
    const chain: any = {
      select: () => chain,
      eq: (col: string, value: any) => {
        filters.push((row) => row[col] === value);
        return chain;
      },
      is: (col: string, value: any) => {
        filters.push((row) => (row[col] ?? null) === value);
        return chain;
      },
      in: () => chain,
      limit: () => chain,
      single: () => Promise.resolve(resolve()),
      maybeSingle: () => Promise.resolve(resolve()),
      then: (onFulfilled: any, onRejected: any) =>
        Promise.resolve(resolve()).then(onFulfilled, onRejected),
    };
    return chain;
  };
  return { from: (table: string) => makeChain(table) } as any;
}

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

const ACCOUNT_A = '11111111-1111-1111-1111-111111111111';
const ACCOUNT_B = '22222222-2222-2222-2222-222222222222';

const memberOfA = { id: 'mem-1', account_id: ACCOUNT_A, user_id: 'user-a', removed_at: null };
const memberOfB = { id: 'mem-2', account_id: ACCOUNT_B, user_id: 'user-b', removed_at: null };

beforeEach(() => clearPermissionCache());

describe('hasActiveAccountMembership', () => {
  it('is true for an active member row', async () => {
    const db = stubSupabase({ account_members: [memberOfA], accounts: [] });
    expect(await hasActiveAccountMembership('user-a', ACCOUNT_A, db)).toBe(true);
  });

  it('is false for a soft-removed member', async () => {
    const db = stubSupabase({
      account_members: [{ ...memberOfA, removed_at: '2026-01-01T00:00:00Z' }],
      accounts: [],
    });
    expect(await hasActiveAccountMembership('user-a', ACCOUNT_A, db)).toBe(false);
  });

  it('is true for the account manager', async () => {
    const db = stubSupabase({
      account_members: [],
      accounts: [{ id: ACCOUNT_A, account_manager_id: 'user-a' }],
    });
    expect(await hasActiveAccountMembership('user-a', ACCOUNT_A, db)).toBe(true);
  });

  it('is false when the client is missing', async () => {
    expect(await hasActiveAccountMembership('user-a', ACCOUNT_A, null)).toBe(false);
  });
});

describe('checkEstimateAccess', () => {
  it('allows a member holding the permission', async () => {
    const db = stubSupabase({ account_members: [memberOfA], accounts: [] });
    const decision = await checkEstimateAccess(
      profile('user-a', { [Permission.VIEW_ESTIMATES]: true }),
      Permission.VIEW_ESTIMATES,
      ACCOUNT_A,
      db,
    );
    expect(decision).toEqual({ allowed: true });
  });

  it('rejects a member without the permission', async () => {
    const db = stubSupabase({ account_members: [memberOfA], accounts: [] });
    const decision = await checkEstimateAccess(
      profile('user-a', {}),
      Permission.VIEW_ESTIMATES,
      ACCOUNT_A,
      db,
    );
    expect(decision).toEqual({ allowed: false, reason: 'missing_permission' });
  });

  // Scenario 1/2/3 acceptance: permission must never beat tenancy.
  it('rejects a non-member who holds the permission AND every override permission', async () => {
    const db = stubSupabase({ account_members: [memberOfB], accounts: [] });
    const decision = await checkEstimateAccess(
      profile('user-b', {
        [Permission.VIEW_ESTIMATES]: true,
        [Permission.UPDATE_ESTIMATES]: true,
        [Permission.VIEW_ALL_ACCOUNTS]: true,
        [Permission.MANAGE_ALL_PROJECTS]: true,
        [Permission.VIEW_ALL_ANALYTICS]: true,
      }),
      Permission.UPDATE_ESTIMATES,
      ACCOUNT_A, // user-b belongs to B only
      db,
    );
    expect(decision).toEqual({ allowed: false, reason: 'not_a_member' });
  });

  it('rejects a removed member even with the permission', async () => {
    const db = stubSupabase({
      account_members: [{ ...memberOfA, removed_at: '2026-01-01T00:00:00Z' }],
      accounts: [],
    });
    const decision = await checkEstimateAccess(
      profile('user-a', { [Permission.VIEW_ESTIMATES]: true }),
      Permission.VIEW_ESTIMATES,
      ACCOUNT_A,
      db,
    );
    expect(decision).toEqual({ allowed: false, reason: 'not_a_member' });
  });

  it('rejects an unauthenticated caller even with permissions loaded', async () => {
    const db = stubSupabase({ account_members: [memberOfA], accounts: [] });
    const decision = await checkEstimateAccess(null, Permission.VIEW_ESTIMATES, ACCOUNT_A, db);
    expect(decision).toEqual({ allowed: false, reason: 'unauthenticated' });
  });

  it('rejects when no account is supplied', async () => {
    const db = stubSupabase({ account_members: [memberOfA], accounts: [] });
    const decision = await checkEstimateAccess(
      profile('user-a', { [Permission.VIEW_ESTIMATES]: true }),
      Permission.VIEW_ESTIMATES,
      null,
      db,
    );
    expect(decision).toEqual({ allowed: false, reason: 'not_a_member' });
  });

  it('allows a superadmin on any account', async () => {
    const db = stubSupabase({ account_members: [], accounts: [] });
    const decision = await checkEstimateAccess(
      profile('root', {}, { isSuperadmin: true }),
      Permission.VIEW_ESTIMATES,
      ACCOUNT_B,
      db,
    );
    expect(decision).toEqual({ allowed: true });
  });

  it('covers every lifecycle action through the shared mapping', () => {
    expect(Object.values(ESTIMATE_PERMISSIONS)).toEqual([
      'view_estimates',
      'create_estimates',
      'update_estimates',
      'send_estimates',
      'accept_estimates',
      'reject_estimates',
    ]);
  });
});

describe('requireEstimatePermission', () => {
  it('throws AuthenticationError when unauthenticated', async () => {
    const db = stubSupabase({ account_members: [], accounts: [] });
    await expect(
      requireEstimatePermission(null, Permission.CREATE_ESTIMATES, ACCOUNT_A, db),
    ).rejects.toBeInstanceOf(AuthenticationError);
  });

  it('throws PermissionError for a cross-account attempt', async () => {
    const db = stubSupabase({ account_members: [memberOfB], accounts: [] });
    await expect(
      requireEstimatePermission(
        profile('user-b', { [Permission.CREATE_ESTIMATES]: true }),
        Permission.CREATE_ESTIMATES,
        ACCOUNT_A,
        db,
      ),
    ).rejects.toBeInstanceOf(PermissionError);
  });

  it('returns the profile when both gates pass', async () => {
    const db = stubSupabase({ account_members: [memberOfA], accounts: [] });
    const user = profile('user-a', { [Permission.CREATE_ESTIMATES]: true });
    await expect(
      requireEstimatePermission(user, Permission.CREATE_ESTIMATES, ACCOUNT_A, db),
    ).resolves.toBe(user);
  });
});
