/**
 * POST /api/estimates/[estimateId]/accept — sent -> accepted (terminal).
 * Requires accept_estimates on the estimate's account.
 */

import { NextRequest } from 'next/server';
import { handleEstimateLifecycleAction } from '@/lib/estimate-lifecycle-route';

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ estimateId: string }> },
) {
  return handleEstimateLifecycleAction(request, context, 'accept');
}
