/**
 * POST /api/estimates/[estimateId]/reject — sent -> rejected (terminal).
 * Requires reject_estimates on the estimate's account.
 */

import { NextRequest } from 'next/server';
import { handleEstimateLifecycleAction } from '@/lib/estimate-lifecycle-route';

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ estimateId: string }> },
) {
  return handleEstimateLifecycleAction(request, context, 'reject');
}
