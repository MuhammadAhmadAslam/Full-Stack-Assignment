/**
 * Financial (estimates) authorization — the single place that decides
 * whether a user may touch financial data, and the only place that should
 * be used by estimate routes and pages.
 *
 * Two independent gates, both required:
 *   1. ACTIVE ACCOUNT MEMBERSHIP, derived from the authenticated user id —
 *      never from a client-supplied accountId on its own;
 *   2. the financial permission itself (VIEW_/CREATE_/UPDATE_/SEND_/
 *      ACCEPT_/REJECT_ESTIMATES).
 *
 * Membership is evaluated BEFORE the permission, and the permission is
 * evaluated WITHOUT account context. Consequence: a user holding every
 * override permission (view_all_accounts, manage_all_projects, ...) still
 * cannot reach an account they do not belong to. Permission alone is never
 * sufficient, which is exactly what the acceptance criteria require.
 *
 * This mirrors public.user_has_account_access() in
 * supabase/migrations/20261120220000_add_estimates_rls.sql so the database
 * and the application enforce the same rule with the same definition of
 * membership (active account_members row, account manager, superadmin).
 */

import type { AppSupabaseClient } from './supabase';
import type { UserWithRoles } from './rbac-types';
import { Permission } from './permissions';
import { checkPermissionHybrid, isSuperadmin } from './permission-checker';
import { AuthenticationError, PermissionError } from './server-guards';
import { logger } from './debug-logger';

/**
 * Estimate lifecycle action -> required permission.
 * Single source of truth: routes and UI must read this instead of hardcoding.
 */
export const ESTIMATE_PERMISSIONS = {
  read: Permission.VIEW_ESTIMATES,
  create: Permission.CREATE_ESTIMATES,
  update: Permission.UPDATE_ESTIMATES,
  send: Permission.SEND_ESTIMATES,
  accept: Permission.ACCEPT_ESTIMATES,
  reject: Permission.REJECT_ESTIMATES,
} as const;

export type EstimateAction = keyof typeof ESTIMATE_PERMISSIONS;

export type FinancialDenialReason = 'unauthenticated' | 'not_a_member' | 'missing_permission';

export interface FinancialAccessDecision {
  allowed: boolean;
  reason?: FinancialDenialReason;
}

/**
 * Strict account membership for financial data.
 *
 * TRUE only when the user is:
 *   - named as accounts.account_manager_id, or
 *   - an active account_members row (removed_at IS NULL).
 *
 * Deliberately narrower than hasAccountAccess() in permission-checker.ts:
 * project/task assignment does NOT expose financial rows.
 * Superadmin is handled by the caller (checkEstimateAccess) so this
 * function stays a pure membership predicate.
 */
export async function hasActiveAccountMembership(
  userId: string,
  accountId: string,
  supabaseClient: AppSupabaseClient | null | undefined,
): Promise<boolean> {
  if (!supabaseClient || !userId || !accountId) return false;

  try {
    const { data: membership, error: membershipError } = await supabaseClient
      .from('account_members')
      .select('id')
      .eq('account_id', accountId)
      .eq('user_id', userId)
      .is('removed_at', null)
      .limit(1);

    if (membershipError) {
      logger.error('Error checking account membership', { userId, accountId }, membershipError);
    }

    if (membership && membership.length > 0) return true;

    const { data: managedAccount, error: accountError } = await supabaseClient
      .from('accounts')
      .select('id')
      .eq('id', accountId)
      .eq('account_manager_id', userId)
      .limit(1);

    if (accountError) {
      logger.error('Error checking account manager', { userId, accountId }, accountError);
    }

    return !!(managedAccount && managedAccount.length > 0);
  } catch (error: unknown) {
    logger.error('Exception in hasActiveAccountMembership', { userId, accountId }, error as Error);
    return false;
  }
}

/**
 * Full decision for one financial action on one account.
 *
 * @param userProfile   authenticated profile (null/undefined => unauthenticated)
 * @param permission    one of the financial permissions
 * @param accountId     account that owns the estimate — verified, never trusted
 * @param supabaseClient authenticated Supabase client (REQUIRED server-side)
 */
export async function checkEstimateAccess(
  userProfile: UserWithRoles | null | undefined,
  permission: Permission,
  accountId: string | null | undefined,
  supabaseClient: AppSupabaseClient | null | undefined,
): Promise<FinancialAccessDecision> {
  if (!userProfile) {
    return { allowed: false, reason: 'unauthenticated' };
  }

  if (!accountId) {
    return { allowed: false, reason: 'not_a_member' };
  }

  // Superadmin bypasses membership, matching the rest of the application
  // (and the SQL helper). Everything else must prove membership.
  if (!isSuperadmin(userProfile)) {
    const isMember = await hasActiveAccountMembership(userProfile.id, accountId, supabaseClient);
    if (!isMember) {
      logger.warn('Financial access denied: not an account member', {
        userId: userProfile.id,
        accountId,
        permission,
        reason: 'not_a_member',
      });
      return { allowed: false, reason: 'not_a_member' };
    }
  }

  // No context passed on purpose: membership was already enforced above,
  // and passing context here would let an override short-circuit it.
  const hasPermission = await checkPermissionHybrid(
    userProfile,
    permission,
    undefined,
    supabaseClient,
  );

  if (!hasPermission) {
    logger.warn('Financial access denied: missing permission', {
      userId: userProfile.id,
      accountId,
      permission,
      reason: 'missing_permission',
    });
    return { allowed: false, reason: 'missing_permission' };
  }

  return { allowed: true };
}

/**
 * Throwing variant for API routes.
 *
 * Usage:
 *   const user = await requireEstimatePermission(
 *     await requireAuthentication(request),
 *     ESTIMATE_PERMISSIONS.read,
 *     accountId,
 *     supabase,
 *   );
 *
 * Throws AuthenticationError (401) when unauthenticated and PermissionError
 * (403) for both a missing permission and a non-member account, so the
 * caller cannot distinguish "wrong account" from "wrong permission".
 */
export async function requireEstimatePermission(
  userProfile: UserWithRoles | null | undefined,
  permission: Permission,
  accountId: string | null | undefined,
  supabaseClient: AppSupabaseClient | null | undefined,
): Promise<UserWithRoles> {
  const decision = await checkEstimateAccess(userProfile, permission, accountId, supabaseClient);

  if (decision.allowed && userProfile) {
    return userProfile;
  }

  if (decision.reason === 'unauthenticated' || !userProfile) {
    throw new AuthenticationError('You must be logged in to access financial data');
  }

  throw new PermissionError('You do not have access to estimates for this account', permission);
}
