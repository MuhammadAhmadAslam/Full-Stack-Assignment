/**
 * HTTP glue for estimate lifecycle actions (send / accept / reject).
 *
 * The rules themselves live in lib/estimate-service.ts:
 *   * the current status is read from the database, never from the request;
 *   * the action's permission (send_/accept_/reject_estimates) is required on
 *     the estimate's own account;
 *   * the transition must be in ESTIMATE_STATUS_TRANSITIONS;
 *   * the UPDATE is conditional on the status that was just read
 *     (`WHERE id = ? AND status = <from>`), so a concurrent change makes the
 *     update match zero rows and surfaces as a 409 instead of overwriting.
 *
 * There is deliberately no delete action.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createApiSupabaseClient, getUserProfileFromRequest } from '@/lib/supabase-server';
import {
  estimateService,
  serializeEstimate,
  EstimateNotFoundError,
  EstimateServiceError,
  type EstimateStatus,
} from '@/lib/estimate-service';
import { Permission } from '@/lib/permissions';
import { uuidSchema } from '@/lib/validation-schemas';
import { AuthenticationError, PermissionError } from '@/lib/server-guards';
import { logger } from '@/lib/debug-logger';

export type EstimateLifecycleAction = 'send' | 'accept' | 'reject';

export const ESTIMATE_LIFECYCLE_ACTIONS: Record<
  EstimateLifecycleAction,
  { from: EstimateStatus; to: EstimateStatus; permission: Permission; method: 'sendEstimate' | 'acceptEstimate' | 'rejectEstimate' }
> = {
  send: {
    from: 'draft',
    to: 'sent',
    permission: Permission.SEND_ESTIMATES,
    method: 'sendEstimate',
  },
  accept: {
    from: 'sent',
    to: 'accepted',
    permission: Permission.ACCEPT_ESTIMATES,
    method: 'acceptEstimate',
  },
  reject: {
    from: 'sent',
    to: 'rejected',
    permission: Permission.REJECT_ESTIMATES,
    method: 'rejectEstimate',
  },
};

function lifecycleErrorResponse(error: unknown, action: EstimateLifecycleAction): NextResponse {
  if (error instanceof AuthenticationError) {
    return NextResponse.json({ error: error.message }, { status: 401 });
  }

  // A member without the action's permission is 403; an estimate in another
  // account is 404 so it cannot be probed with status changes.
  if (error instanceof PermissionError) {
    return NextResponse.json({ error: error.message, code: 'FORBIDDEN' }, { status: 403 });
  }

  if (error instanceof EstimateNotFoundError) {
    return NextResponse.json({ error: 'Estimate not found' }, { status: 404 });
  }

  if (error instanceof EstimateServiceError) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  }

  logger.error(
    'Unhandled error in estimate lifecycle action',
    { action },
    error as Error,
  );
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function handleEstimateLifecycleAction(
  request: NextRequest,
  context: { params: Promise<{ estimateId: string }> },
  action: EstimateLifecycleAction,
): Promise<NextResponse> {
  try {
    const { estimateId } = await context.params;

    if (!uuidSchema.safeParse(estimateId).success) {
      return NextResponse.json({ error: 'Invalid estimate ID' }, { status: 400 });
    }

    const supabase = createApiSupabaseClient(request);
    if (!supabase) {
      return NextResponse.json({ error: 'Database connection not available' }, { status: 500 });
    }

    const userProfile = await getUserProfileFromRequest(supabase);
    if (!userProfile) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const config = ESTIMATE_LIFECYCLE_ACTIONS[action];

    // Status is read fresh inside the service; the request body is ignored,
    // so a client can never name the status it wants to move to or from.
    const updated = await estimateService[config.method](estimateId, userProfile, supabase);

    return NextResponse.json(
      {
        success: true,
        estimate: serializeEstimate(updated),
        previous_status: config.from,
        status: updated.status,
      },
      { status: 200 },
    );
  } catch (error: unknown) {
    return lifecycleErrorResponse(error, action);
  }
}
