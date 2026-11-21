/**
 * GET /api/estimates/[estimateId]
 *
 * Returns one estimate with its line items.
 *
 * Query parameters:
 *   account_id   optional UUID — when present the estimate must belong to it
 *
 * Security posture:
 *   * 400 for a malformed id, before any database access;
 *   * 401 without a session;
 *   * membership + view_estimates are enforced on the estimate's own
 *     account_id (never on a client-supplied one);
 *   * a missing estimate, an estimate from another account, and an estimate
 *     the caller may not read all return the same 404 — an id from another
 *     tenant is indistinguishable from an id that does not exist;
 *   * the response is an explicit allowlist of fields, so internal columns
 *     (created_by, future audit fields) never leak.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createApiSupabaseClient, getUserProfileFromRequest } from '@/lib/supabase-server';
import {
  estimateService,
  serializeEstimateWithItems,
  EstimateNotFoundError,
  EstimateServiceError,
} from '@/lib/estimate-service';
import { uuidSchema, updateEstimateSchema } from '@/lib/validation-schemas';
import { AuthenticationError, PermissionError } from '@/lib/server-guards';
import { logger } from '@/lib/debug-logger';

const querySchema = z.object({ account_id: uuidSchema.optional() }).strict();

function errorResponse(error: unknown): NextResponse {
  if (error instanceof AuthenticationError) {
    return NextResponse.json({ error: error.message }, { status: 401 });
  }

  // A member without view_estimates is a permission failure (403); a caller
  // from another account gets 404 so an existing id cannot be probed.
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
    'Unhandled error in GET /api/estimates/[estimateId]',
    { action: 'get_estimate' },
    error as Error,
  );
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

/**
 * PATCH /api/estimates/[estimateId] — edit a draft.
 *
 * Only drafts are editable: the service returns 409 for sent/accepted/
 * rejected rows and uses a compare-and-set update so a concurrent send
 * cannot be overwritten. Totals are recalculated server-side.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ estimateId: string }> },
) {
  try {
    const { estimateId } = await params;

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

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: 'Request body must be valid JSON', code: 'INVALID_JSON' },
        { status: 400 },
      );
    }

    const parsed = updateEstimateSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: 'Invalid estimate payload',
          details: parsed.error.issues.map((issue) => ({
            field: issue.path.join('.') || 'body',
            message: issue.message,
          })),
        },
        { status: 400 },
      );
    }

    const result = await estimateService.updateEstimate(
      estimateId,
      parsed.data,
      userProfile,
      supabase,
    );

    return NextResponse.json(
      { success: true, estimate: serializeEstimateWithItems(result) },
      { status: 200 },
    );
  } catch (error: unknown) {
    return errorResponse(error);
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ estimateId: string }> },
) {
  try {
    const { estimateId } = await params;

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

    const rawQuery = Object.fromEntries(new URL(request.url).searchParams.entries());
    const parsedQuery = querySchema.safeParse(rawQuery);
    if (!parsedQuery.success) {
      return NextResponse.json(
        {
          error: 'Invalid query parameters',
          details: parsedQuery.error.issues.map((issue) => ({
            field: issue.path.join('.') || 'query',
            message: issue.message,
          })),
        },
        { status: 400 },
      );
    }

    const result = await estimateService.getEstimate(estimateId, userProfile, supabase, {
      accountId: parsedQuery.data.account_id,
    });

    return NextResponse.json(
      { success: true, estimate: serializeEstimateWithItems(result) },
      { status: 200 },
    );
  } catch (error: unknown) {
    return errorResponse(error);
  }
}
