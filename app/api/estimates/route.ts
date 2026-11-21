/**
 * GET /api/estimates — account-scoped estimates list.
 *
 * Query parameters (all validated, unknown ones rejected):
 *   account_id    required, UUID — the tenant whose estimates are listed
 *   status        draft | sent | accepted | rejected
 *   project_id    UUID
 *   search        substring match on estimate_number (case-insensitive)
 *   created_from  YYYY-MM-DD or ISO timestamp (inclusive)
 *   created_to    YYYY-MM-DD or ISO timestamp (inclusive)
 *   sort          created_at | updated_at | estimate_number | status | total_minor
 *   direction     asc | desc (default desc)
 *   limit         1..100 (default 25)
 *   offset        >= 0 (default 0)
 *
 * Security: the caller must be authenticated AND an active member of
 * account_id holding view_estimates; the service re-derives the account from
 * the database and RLS on estimates enforces the same rule a second time.
 * Filtering and pagination happen in SQL — the response never contains rows
 * from another account or rows the client would have to filter itself.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createApiSupabaseClient, getUserProfileFromRequest } from '@/lib/supabase-server';
import { estimateService, EstimateServiceError } from '@/lib/estimate-service';
import { estimateListQuerySchema, createEstimateSchema } from '@/lib/validation-schemas';
import { readIdempotencyKeyHeader, IdempotencyKeyError } from '@/lib/idempotency';
import { AuthenticationError, PermissionError } from '@/lib/server-guards';
import { logger } from '@/lib/debug-logger';

function errorResponse(error: unknown): NextResponse {
  if (error instanceof AuthenticationError) {
    return NextResponse.json({ error: error.message }, { status: 401 });
  }

  if (error instanceof PermissionError) {
    return NextResponse.json({ error: error.message, code: 'FORBIDDEN' }, { status: 403 });
  }

  if (error instanceof IdempotencyKeyError) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: 400 });
  }

  if (error instanceof EstimateServiceError) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  }

  logger.error('Unhandled error in GET /api/estimates', { action: 'list_estimates' }, error as Error);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function GET(request: NextRequest) {
  try {
    const supabase = createApiSupabaseClient(request);
    if (!supabase) {
      return NextResponse.json({ error: 'Database connection not available' }, { status: 500 });
    }

    // 1. Authentication — the profile comes from the session, never the query.
    const userProfile = await getUserProfileFromRequest(supabase);
    if (!userProfile) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // 2. Validate the query string before any database access.
    const raw = Object.fromEntries(new URL(request.url).searchParams.entries());
    const parsed = estimateListQuerySchema.safeParse(raw);

    if (!parsed.success) {
      return NextResponse.json(
        {
          error: 'Invalid query parameters',
          details: parsed.error.issues.map((issue) => ({
            field: issue.path.join('.') || 'query',
            message: issue.message,
          })),
        },
        { status: 400 },
      );
    }

    const query = parsed.data;

    // 3. Membership + view_estimates are enforced inside the service.
    const result = await estimateService.listEstimates(
      {
        accountId: query.account_id,
        status: query.status,
        projectId: query.project_id,
        search: query.search,
        createdFrom: query.created_from,
        createdTo: query.created_to,
        sort: query.sort,
        direction: query.direction,
        limit: query.limit,
        offset: query.offset,
      },
      userProfile,
      supabase,
    );

    return NextResponse.json(
      {
        success: true,
        estimates: result.estimates,
        pagination: {
          count: result.count,
          limit: result.limit,
          offset: result.offset,
          has_more: result.offset + result.estimates.length < result.count,
        },
      },
      { status: 200 },
    );
  } catch (error: unknown) {
    return errorResponse(error);
  }
}

/**
 * POST /api/estimates — create a draft estimate.
 *
 * Requires an Idempotency-Key header: a retry of the same key + payload
 * replays the original response (200) instead of creating a second
 * estimate, and the same key with a different payload is a 409.
 *
 * The estimate, its line items and the idempotency record are written by
 * one database function in a single transaction, so a failure can never
 * leave a partial estimate, orphan line items or a consumed key.
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = createApiSupabaseClient(request);
    if (!supabase) {
      return NextResponse.json({ error: 'Database connection not available' }, { status: 500 });
    }

    // 1. Authenticated session.
    const userProfile = await getUserProfileFromRequest(supabase);
    if (!userProfile) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // 2. Idempotency-Key is mandatory for money-creating requests.
    if (!readIdempotencyKeyHeader(request)) {
      return NextResponse.json(
        { error: 'Idempotency-Key header is required', code: 'IDEMPOTENCY_KEY_REQUIRED' },
        { status: 400 },
      );
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

    // 3. Schema validation (strict: client totals are rejected, currency and
    //    line items are checked, quantities must be exact decimals).
    const parsed = createEstimateSchema.safeParse(body);
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

    // 4. Membership + create_estimates + project ownership + server-side
    //    totals + atomic insert all happen inside the service.
    const result = await estimateService.createEstimateIdempotent(
      parsed.data,
      userProfile,
      readIdempotencyKeyHeader(request),
      supabase,
    );

    return NextResponse.json(
      {
        success: true,
        estimate: result.estimate,
        line_items: result.lineItems,
        replayed: result.replayed,
      },
      { status: result.replayed ? 200 : 201 },
    );
  } catch (error: unknown) {
    return errorResponse(error);
  }
}
