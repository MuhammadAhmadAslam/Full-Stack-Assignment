/**
 * Estimates domain service.
 *
 * All estimate business rules live here so API routes stay thin:
 *   * account ownership + financial permission (lib/financial-access.ts)
 *   * project association must belong to the same account
 *   * totals are always recalculated server-side (lib/estimate-money.ts)
 *   * lifecycle transitions draft -> sent -> accepted | rejected
 *   * line items are editable only while the estimate is a draft
 *   * no hard deletes are exposed
 *
 * CONCURRENCY
 * Status changes are compare-and-set: the UPDATE carries
 * `.eq('status', <expected>)`, so two simultaneous requests cannot both
 * win. A zero-row result is reported as a conflict (409), never retried
 * silently.
 *
 * TRANSACTION SAFETY
 * supabase-js cannot span multiple statements in one transaction, so
 * multi-row writes use explicit compensation:
 *   * create: the estimate row is deleted again if line items fail;
 *   * edit:   previous line items and monetary totals are restored on failure.
 * The failure window is stated in each method. A Postgres function would
 * remove the window entirely; that is the recommended next step (see the
 * migration note at the bottom of this file).
 */

import { createClientSupabase } from './supabase';
import type { AppSupabaseClient } from './supabase';
import { Permission } from './permissions';
import { requireEstimatePermission, checkEstimateAccess } from './financial-access';
import { computeEstimate, type ComputedEstimateLine, type EstimateLineInput } from './estimate-money';
import {
  computeRequestFingerprint,
  normalizeIdempotencyKey,
  IdempotencyKeyError,
  type IdempotencyOutcome,
} from './idempotency';
import { AuthenticationError, PermissionError } from './server-guards';
import type { UserWithRoles } from './rbac-types';
import { logger } from './debug-logger';

// ============================================================================
// ERRORS (HTTP-ready: status + stable code)
// ============================================================================

export class EstimateServiceError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = 'EstimateServiceError';
    this.status = status;
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class EstimateNotFoundError extends EstimateServiceError {
  constructor(estimateId: string) {
    super(`Estimate ${estimateId} was not found`, 404, 'ESTIMATE_NOT_FOUND');
    this.name = 'EstimateNotFoundError';
  }
}

export class EstimateValidationError extends EstimateServiceError {
  constructor(message: string) {
    super(message, 400, 'ESTIMATE_INVALID');
    this.name = 'EstimateValidationError';
  }
}

export class EstimateConflictError extends EstimateServiceError {
  constructor(message: string) {
    super(message, 409, 'ESTIMATE_CONFLICT');
    this.name = 'EstimateConflictError';
  }
}

export class EstimateDatabaseError extends EstimateServiceError {
  constructor(message: string) {
    super(message, 500, 'ESTIMATE_DB_ERROR');
    this.name = 'EstimateDatabaseError';
  }
}

// ============================================================================
// LIFECYCLE
// ============================================================================

export const ESTIMATE_STATUSES = ['draft', 'sent', 'accepted', 'rejected'] as const;
export type EstimateStatus = (typeof ESTIMATE_STATUSES)[number];

/**
 * Allowed transitions. `accepted` and `rejected` are terminal: there is no
 * reopen path until the business defines one explicitly.
 */
export const ESTIMATE_STATUS_TRANSITIONS: Record<EstimateStatus, readonly EstimateStatus[]> = {
  draft: ['sent'],
  sent: ['accepted', 'rejected'],
  accepted: [],
  rejected: [],
};

export function isEstimateStatus(value: unknown): value is EstimateStatus {
  return typeof value === 'string' && (ESTIMATE_STATUSES as readonly string[]).includes(value);
}

export function canTransition(from: EstimateStatus, to: EstimateStatus): boolean {
  return ESTIMATE_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(from: EstimateStatus, to: EstimateStatus): void {
  if (!canTransition(from, to)) {
    throw new EstimateConflictError(`Cannot change estimate status from ${from} to ${to}`);
  }
}

/** Line items (and other priced fields) may only change while in draft. */
export function isEstimateEditable(status: EstimateStatus): boolean {
  return status === 'draft';
}

// ============================================================================
// TYPES
// ============================================================================

export interface EstimateLineItemInput {
  description: string;
  quantity: number | string;
  unit_price_minor: number;
  sort_order?: number;
}

export interface CreateEstimateInput {
  account_id: string;
  project_id?: string | null;
  estimate_number: string;
  title: string;
  description?: string | null;
  currency?: string;
  line_items?: EstimateLineItemInput[];
  tax_minor?: number;
  tax_rate_bps?: number;
}

export type UpdateEstimateInput = Partial<Omit<CreateEstimateInput, 'account_id'>>;

export interface EstimateRow {
  id: string;
  account_id: string;
  project_id: string | null;
  estimate_number: string;
  title: string;
  description: string | null;
  status: EstimateStatus;
  currency: string;
  subtotal_minor: number;
  tax_minor: number;
  total_minor: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface EstimateLineItemRow {
  id: string;
  estimate_id: string;
  description: string;
  quantity: string;
  unit_price_minor: number;
  amount_minor: number;
  sort_order: number;
  created_at: string;
}

export interface EstimateWithItems {
  estimate: EstimateRow;
  lineItems: EstimateLineItemRow[];
}

export const ESTIMATE_SORT_COLUMNS = [
  'created_at',
  'updated_at',
  'estimate_number',
  'status',
  'total_minor',
] as const;
export type EstimateSortColumn = (typeof ESTIMATE_SORT_COLUMNS)[number];
export type SortDirection = 'asc' | 'desc';

export interface ListEstimatesParams {
  accountId: string;
  status?: EstimateStatus;
  /** Only estimates attached to this project. */
  projectId?: string | null;
  /** Case-insensitive substring match on estimate_number. */
  search?: string | null;
  /** Inclusive lower bound on created_at (date or ISO timestamp). */
  createdFrom?: string | null;
  /** Inclusive upper bound on created_at (date or ISO timestamp). */
  createdTo?: string | null;
  sort?: EstimateSortColumn;
  direction?: SortDirection;
  limit?: number;
  offset?: number;
}

export interface ListEstimatesResult {
  estimates: Array<EstimateRow & { project_name: string | null }>;
  count: number;
  limit: number;
  offset: number;
}

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 25;

/**
 * PostgREST filter syntax uses %, _ and , as operators, so they are stripped
 * from user search input (measured, unquoted ilike values would otherwise
 * change the query or break it).
 */
export function normalizeEstimateSearch(raw?: string | null): string | null {
  if (!raw) return null;
  const cleaned = raw
    .trim()
    .replace(/[%_,()\\*"]/g, '')
    .slice(0, 100);
  return cleaned.length > 0 ? cleaned : null;
}

// ============================================================================
// SERVICE
// ============================================================================

class EstimateService {
  private resolveClient(supabaseClient?: AppSupabaseClient | null): AppSupabaseClient {
    const client = supabaseClient ?? createClientSupabase();
    if (!client) {
      throw new EstimateDatabaseError('Supabase client is not available');
    }
    return client;
  }

  private async fetchEstimateRow(
    supabase: AppSupabaseClient,
    estimateId: string,
  ): Promise<EstimateRow> {
    const { data, error } = await supabase
      .from('estimates')
      .select('*')
      .eq('id', estimateId)
      .maybeSingle();

    if (error) {
      logger.error('Failed to load estimate', { estimateId }, error as Error);
      throw new EstimateDatabaseError('Failed to load the estimate');
    }

    if (!data) throw new EstimateNotFoundError(estimateId);

    return data as EstimateRow;
  }

  /**
   * A project may only be attached when it exists and belongs to the same
   * account. The database enforces this with a composite FK; this check
   * turns a raw FK violation into a clear 400.
   */
  private async assertProjectBelongsToAccount(
    supabase: AppSupabaseClient,
    projectId: string,
    accountId: string,
  ): Promise<void> {
    const { data, error } = await supabase
      .from('projects')
      .select('id, account_id')
      .eq('id', projectId)
      .maybeSingle();

    if (error) {
      logger.error('Failed to load project for estimate', { projectId }, error as Error);
      throw new EstimateDatabaseError('Failed to validate the project');
    }

    if (!data) {
      throw new EstimateValidationError('Project does not exist');
    }

    if ((data as { account_id: string }).account_id !== accountId) {
      throw new EstimateValidationError('Project does not belong to this account');
    }
  }

  /**
   * Access check for a row that has already been loaded.
   *
   * Distinguishes the two denial reasons so the API can answer correctly:
   *   * member without the permission  -> PermissionError (403)
   *   * not a member of the account    -> EstimateNotFoundError (404), so an
   *     id belonging to another tenant is indistinguishable from a made-up id.
   */
  private async assertEstimateAccess(
    userProfile: UserWithRoles | null | undefined,
    permission: Permission,
    estimate: EstimateRow,
    supabase: AppSupabaseClient,
  ): Promise<void> {
    const decision = await checkEstimateAccess(
      userProfile,
      permission,
      estimate.account_id,
      supabase,
    );

    if (decision.allowed) return;

    if (decision.reason === 'unauthenticated') {
      throw new AuthenticationError('You must be logged in to access financial data');
    }

    if (decision.reason === 'missing_permission') {
      throw new PermissionError(
        'You do not have permission to perform this action on this estimate',
        permission,
      );
    }

    throw new EstimateNotFoundError(estimate.id);
  }

  private calculate(input: {
    line_items?: EstimateLineItemInput[];
    tax_minor?: number;
    tax_rate_bps?: number;
  }) {
    const calculated = computeEstimate((input.line_items ?? []) as EstimateLineInput[], {
      taxMinor: input.tax_minor,
      taxRateBps: input.tax_rate_bps,
    });

    if (!calculated.ok) {
      throw new EstimateValidationError(calculated.error.message);
    }

    return calculated.value;
  }

  private lineRows(estimateId: string, lines: ComputedEstimateLine[]) {
    return lines.map((line) => ({
      estimate_id: estimateId,
      description: line.description,
      quantity: line.quantity,
      unit_price_minor: line.unitPriceMinor,
      sort_order: line.sortOrder,
    }));
  }

  private mapDatabaseError(error: { code?: string; message?: string }, context: string): never {
    logger.error(context, { code: error.code, message: error.message }, error as Error);

    if (error.code === '23505') {
      throw new EstimateConflictError('An estimate with this number already exists for this account');
    }
    if (error.code === '23503') {
      throw new EstimateValidationError('Referenced account or project does not exist');
    }
    if (error.code === '23514') {
      throw new EstimateValidationError('Estimate violates a data constraint');
    }

    throw new EstimateDatabaseError('Database operation failed');
  }

  // --------------------------------------------------------------------------
  // CREATE
  // --------------------------------------------------------------------------
  async createEstimate(
    input: CreateEstimateInput,
    userProfile: UserWithRoles | null | undefined,
    supabaseClient?: AppSupabaseClient | null,
  ): Promise<EstimateWithItems> {
    const supabase = this.resolveClient(supabaseClient);

    if (!input?.account_id) {
      throw new EstimateValidationError('account_id is required');
    }

    const user = await requireEstimatePermission(
      userProfile,
      Permission.CREATE_ESTIMATES,
      input.account_id,
      supabase,
    );

    if (input.project_id) {
      await this.assertProjectBelongsToAccount(supabase, input.project_id, input.account_id);
    }

    const calculated = this.calculate(input);

    const { data: created, error } = await supabase
      .from('estimates')
      .insert({
        account_id: input.account_id,
        project_id: input.project_id ?? null,
        estimate_number: input.estimate_number,
        title: input.title,
        description: input.description ?? null,
        status: 'draft',
        currency: (input.currency ?? 'USD').toUpperCase(),
        subtotal_minor: calculated.totals.subtotalMinor,
        tax_minor: calculated.totals.taxMinor,
        total_minor: calculated.totals.totalMinor,
        created_by: user.id,
      })
      .select()
      .single();

    if (error) {
      this.mapDatabaseError(error, 'Failed to create estimate');
    }

    const estimate = created as EstimateRow;

    // Failure window: until line items exist the estimate is an empty draft.
    // If the insert fails we remove the row we just created.
    if (calculated.lines.length > 0) {
      const { error: lineError } = await supabase
        .from('estimate_line_items')
        .insert(this.lineRows(estimate.id, calculated.lines));

      if (lineError) {
        const { error: rollbackError } = await supabase
          .from('estimates')
          .delete()
          .eq('id', estimate.id);

        if (rollbackError) {
          logger.error(
            'Estimate rollback failed after line-item insert error',
            { estimateId: estimate.id },
            rollbackError as Error,
          );
        }

        this.mapDatabaseError(lineError, 'Failed to save estimate line items');
      }
    }

    const lineItems = await this.getLineItems(supabase, estimate.id);

    return { estimate, lineItems };
  }

  // --------------------------------------------------------------------------
  // CREATE (idempotent, requires Idempotency-Key)
  // --------------------------------------------------------------------------

  /**
   * Idempotent variant used by POST /api/estimates when an Idempotency-Key
   * header is present (and always, if the route requires the header).
   *
   * The duplicate decision is made by the database in one transaction:
   *   * first request  -> claim key, create estimate, store replay envelope
   *   * same key+hash  -> 'replay', returns the stored envelope
   *   * same key, new hash -> 'conflict' (409), nothing is written
   *   * concurrent duplicates -> the unique index serialises them
   *
   * If the creation fails, the whole transaction rolls back (including the
   * key), so the client may retry with the same key.
   */
  async createEstimateIdempotent(
    input: CreateEstimateInput,
    userProfile: UserWithRoles | null | undefined,
    idempotencyKey: string | null | undefined,
    supabaseClient?: AppSupabaseClient | null,
  ): Promise<EstimateWithItems & { replayed: boolean; outcome: IdempotencyOutcome }> {
    const supabase = this.resolveClient(supabaseClient);

    let key: string | null;
    try {
      key = normalizeIdempotencyKey(idempotencyKey);
    } catch (error: unknown) {
      if (error instanceof IdempotencyKeyError) throw error;
      throw new IdempotencyKeyError();
    }

    if (!key) {
      throw new IdempotencyKeyError(
        'Idempotency-Key header is required when creating an estimate',
      );
    }

    if (!input?.account_id) {
      throw new EstimateValidationError('account_id is required');
    }

    await requireEstimatePermission(
      userProfile,
      Permission.CREATE_ESTIMATES,
      input.account_id,
      supabase,
    );

    if (input.project_id) {
      await this.assertProjectBelongsToAccount(supabase, input.project_id, input.account_id);
    }

    const calculated = this.calculate(input);
    const currency = (input.currency ?? 'USD').toUpperCase();

    // Fingerprint the NORMALISED payload: currency case, quantity formatting
    // and computed totals are canonical, so semantically identical requests
    // replay instead of conflicting.
    const lines = calculated.lines.map((line) => ({
      description: line.description,
      quantity: line.quantity,
      unit_price_minor: line.unitPriceMinor,
      sort_order: line.sortOrder,
    }));

    const requestHash = computeRequestFingerprint({
      account_id: input.account_id,
      project_id: input.project_id ?? null,
      estimate_number: input.estimate_number,
      title: input.title,
      description: input.description ?? null,
      currency,
      subtotal_minor: calculated.totals.subtotalMinor,
      tax_minor: calculated.totals.taxMinor,
      total_minor: calculated.totals.totalMinor,
      line_items: lines,
    });

    const { data, error } = await supabase.rpc('create_estimate_idempotent', {
      p_account_id: input.account_id,
      p_idempotency_key: key,
      p_request_hash: requestHash,
      p_estimate_number: input.estimate_number,
      p_title: input.title,
      p_description: input.description ?? null,
      p_currency: currency,
      p_project_id: input.project_id ?? null,
      p_subtotal_minor: calculated.totals.subtotalMinor,
      p_tax_minor: calculated.totals.taxMinor,
      p_total_minor: calculated.totals.totalMinor,
      p_lines: lines,
      p_response_status: 201,
    });

    if (error) {
      if (error.code === '42501') {
        throw new PermissionError(
          'You do not have access to estimates for this account',
          Permission.CREATE_ESTIMATES,
        );
      }
      this.mapDatabaseError(error, 'Idempotent estimate creation failed');
    }

    const row = (Array.isArray(data) ? data[0] : data) as
      | { outcome: IdempotencyOutcome; response_body: { estimate: EstimateRow; lineItems?: EstimateLineItemRow[] } | null }
      | null
      | undefined;

    if (!row) {
      throw new EstimateDatabaseError('Idempotent estimate creation returned no result');
    }

    if (row.outcome === 'conflict') {
      throw new EstimateConflictError(
        'Idempotency-Key has already been used with a different payload',
      );
    }

    if (!row.response_body) {
      throw new EstimateDatabaseError('Idempotent estimate creation returned an empty result');
    }

    return {
      estimate: row.response_body.estimate,
      lineItems: row.response_body.lineItems ?? [],
      replayed: row.outcome === 'replay',
      outcome: row.outcome,
    };
  }

  // --------------------------------------------------------------------------
  // READ
  // --------------------------------------------------------------------------
  private async getLineItems(
    supabase: AppSupabaseClient,
    estimateId: string,
  ): Promise<EstimateLineItemRow[]> {
    const { data, error } = await supabase
      .from('estimate_line_items')
      .select('*')
      .eq('estimate_id', estimateId);

    if (error) {
      logger.error('Failed to load estimate line items', { estimateId }, error as Error);
      throw new EstimateDatabaseError('Failed to load estimate line items');
    }

    return ((data ?? []) as EstimateLineItemRow[]).slice().sort((a, b) => a.sort_order - b.sort_order);
  }

  async getEstimate(
    estimateId: string,
    userProfile: UserWithRoles | null | undefined,
    supabaseClient?: AppSupabaseClient | null,
    options?: { accountId?: string | null },
  ): Promise<EstimateWithItems> {
    const supabase = this.resolveClient(supabaseClient);
    const estimate = await this.fetchEstimateRow(supabase, estimateId);

    // When the caller supplies an account context, the row must belong to it.
    // A mismatch is reported as "not found" so an id from another account is
    // indistinguishable from an id that does not exist.
    if (options?.accountId && estimate.account_id !== options.accountId) {
      throw new EstimateNotFoundError(estimateId);
    }

    await this.assertEstimateAccess(userProfile, Permission.VIEW_ESTIMATES, estimate, supabase);

    const lineItems = await this.getLineItems(supabase, estimateId);
    return { estimate, lineItems };
  }

  async listEstimates(
    params: ListEstimatesParams,
    userProfile: UserWithRoles | null | undefined,
    supabaseClient?: AppSupabaseClient | null,
  ): Promise<ListEstimatesResult> {
    const supabase = this.resolveClient(supabaseClient);

    await requireEstimatePermission(
      userProfile,
      Permission.VIEW_ESTIMATES,
      params.accountId,
      supabase,
    );

    const limit = Math.min(Math.max(params.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const offset = Math.max(params.offset ?? 0, 0);

    const sortColumn: EstimateSortColumn = (ESTIMATE_SORT_COLUMNS as readonly string[]).includes(
      params.sort ?? 'created_at',
    )
      ? (params.sort as EstimateSortColumn) ?? 'created_at'
      : 'created_at';
    const ascending = params.direction === 'asc';

    // Every filter is applied in SQL; the caller never receives a wider row
    // set that it would have to filter client-side.
    let query = supabase
      .from('estimates')
      .select('*', { count: 'exact' })
      .eq('account_id', params.accountId);

    if (params.status) {
      query = query.eq('status', params.status);
    }

    if (params.projectId) {
      query = query.eq('project_id', params.projectId);
    }

    if (params.createdFrom) {
      query = query.gte('created_at', params.createdFrom);
    }

    if (params.createdTo) {
      query = query.lte('created_at', params.createdTo);
    }

    const search = normalizeEstimateSearch(params.search);
    if (search) {
      query = query.ilike('estimate_number', `%${search}%`);
    }

    // Secondary sort on id keeps pagination deterministic when the primary
    // column has ties.
    const { data, error, count } = await query
      .order(sortColumn, { ascending })
      .order('id', { ascending })
      .range(offset, offset + limit - 1);

    if (error) {
      logger.error('Failed to list estimates', { accountId: params.accountId }, error as Error);
      throw new EstimateDatabaseError('Failed to list estimates');
    }

    const rows = (data ?? []) as EstimateRow[];

    // Resolve project names for display. Scoped to the same account, so a
    // foreign project id can never resolve to a name.
    const projectIds = Array.from(
      new Set(rows.map((row) => row.project_id).filter((id): id is string => Boolean(id))),
    );
    const projectNames = new Map<string, string>();

    if (projectIds.length > 0) {
      const { data: projects, error: projectError } = await supabase
        .from('projects')
        .select('id, name')
        .eq('account_id', params.accountId)
        .in('id', projectIds);

      if (projectError) {
        // Names are cosmetic; never fail the list because of them.
        logger.warn('Failed to load project names for estimates', {
          accountId: params.accountId,
        });
      } else {
        ((projects ?? []) as Array<{ id: string; name: string }>).forEach((project) =>
          projectNames.set(project.id, project.name),
        );
      }
    }

    return {
      estimates: rows.map((row) => ({
        ...row,
        project_name: row.project_id ? projectNames.get(row.project_id) ?? null : null,
      })),
      count: count ?? rows.length,
      limit,
      offset,
    };
  }

  // --------------------------------------------------------------------------
  // UPDATE (draft only)
  // --------------------------------------------------------------------------
  async updateEstimate(
    estimateId: string,
    input: UpdateEstimateInput,
    userProfile: UserWithRoles | null | undefined,
    supabaseClient?: AppSupabaseClient | null,
  ): Promise<EstimateWithItems> {
    const supabase = this.resolveClient(supabaseClient);
    const snapshot = await this.fetchEstimateRow(supabase, estimateId);

    await this.assertEstimateAccess(
      userProfile,
      Permission.UPDATE_ESTIMATES,
      snapshot,
      supabase,
    );

    if (!isEstimateEditable(snapshot.status)) {
      throw new EstimateConflictError(
        `Estimate is ${snapshot.status}; only draft estimates can be edited`,
      );
    }

    if (input.project_id) {
      await this.assertProjectBelongsToAccount(supabase, input.project_id, snapshot.account_id);
    }

    const taxInstruction = {
      tax_minor: input.tax_minor,
      tax_rate_bps: input.tax_rate_bps,
    };
    const hasTaxInstruction =
      taxInstruction.tax_minor !== undefined || taxInstruction.tax_rate_bps !== undefined;

    let calculated: ReturnType<EstimateService['calculate']> | null = null;

    if (input.line_items !== undefined) {
      calculated = this.calculate({ line_items: input.line_items, ...taxInstruction });
    } else if (hasTaxInstruction) {
      // Recompute against the stored lines so the totals stay consistent
      // with whatever is actually persisted.
      const existing = await this.getLineItems(supabase, estimateId);
      calculated = this.calculate({
        line_items: existing.map((line) => ({
          description: line.description,
          quantity: line.quantity,
          unit_price_minor: line.unit_price_minor,
          sort_order: line.sort_order,
        })),
        ...taxInstruction,
      });
    }

    const updates: Record<string, unknown> = {};
    if (input.estimate_number !== undefined) updates.estimate_number = input.estimate_number;
    if (input.title !== undefined) updates.title = input.title;
    if (input.description !== undefined) updates.description = input.description;
    if (input.currency !== undefined) updates.currency = input.currency.toUpperCase();
    if (input.project_id !== undefined) updates.project_id = input.project_id;
    if (calculated) {
      updates.subtotal_minor = calculated.totals.subtotalMinor;
      updates.tax_minor = calculated.totals.taxMinor;
      updates.total_minor = calculated.totals.totalMinor;
    }

    if (Object.keys(updates).length === 0) {
      return { estimate: snapshot, lineItems: await this.getLineItems(supabase, estimateId) };
    }

    // Compare-and-set against the snapshot status: a concurrent send() makes
    // this match zero rows instead of silently editing a sent estimate.
    const { data: updated, error } = await supabase
      .from('estimates')
      .update(updates)
      .eq('id', estimateId)
      .eq('status', 'draft')
      .select()
      .maybeSingle();

    if (error) {
      this.mapDatabaseError(error, 'Failed to update estimate');
    }

    if (!updated) {
      throw new EstimateConflictError('Estimate changed concurrently; reload and try again');
    }

    if (calculated && input.line_items !== undefined) {
      try {
        await this.replaceLineItems(supabase, estimateId, calculated.lines);
      } catch (error: unknown) {
        // Compensate: the header already carries the new totals, so put the
        // previous monetary values back before surfacing the failure.
        await this.restoreTotals(supabase, snapshot);
        throw error;
      }
    }

    return {
      estimate: updated as EstimateRow,
      lineItems: await this.getLineItems(supabase, estimateId),
    };
  }

  /**
   * Replace the whole line set. Previous rows are snapshotted first and
   * re-inserted if the new set cannot be written, so a failed edit cannot
   * leave an estimate with no lines.
   */
  private async replaceLineItems(
    supabase: AppSupabaseClient,
    estimateId: string,
    lines: ComputedEstimateLine[],
  ): Promise<void> {
    const previous = await this.getLineItems(supabase, estimateId);

    const { error: deleteError } = await supabase
      .from('estimate_line_items')
      .delete()
      .eq('estimate_id', estimateId);

    if (deleteError) {
      this.mapDatabaseError(deleteError, 'Failed to clear existing line items');
    }

    if (lines.length === 0) return;

    const { error: insertError } = await supabase
      .from('estimate_line_items')
      .insert(this.lineRows(estimateId, lines));

    if (insertError) {
      if (previous.length > 0) {
        const { error: restoreError } = await supabase
          .from('estimate_line_items')
          .insert(
            previous.map((line) => ({
              estimate_id: estimateId,
              description: line.description,
              quantity: line.quantity,
              unit_price_minor: line.unit_price_minor,
              sort_order: line.sort_order,
            })),
          );

        if (restoreError) {
          logger.error(
            'Failed to restore previous line items',
            { estimateId },
            restoreError as Error,
          );
        }
      }

      this.mapDatabaseError(insertError, 'Failed to save new line items');
    }
  }

  private async restoreTotals(supabase: AppSupabaseClient, snapshot: EstimateRow): Promise<void> {
    const { error } = await supabase
      .from('estimates')
      .update({
        subtotal_minor: snapshot.subtotal_minor,
        tax_minor: snapshot.tax_minor,
        total_minor: snapshot.total_minor,
      })
      .eq('id', snapshot.id);

    if (error) {
      logger.error('Failed to restore estimate totals', { estimateId: snapshot.id }, error as Error);
    }
  }

  // --------------------------------------------------------------------------
  // LIFECYCLE TRANSITIONS
  // --------------------------------------------------------------------------
  async sendEstimate(
    estimateId: string,
    userProfile: UserWithRoles | null | undefined,
    supabaseClient?: AppSupabaseClient | null,
  ): Promise<EstimateRow> {
    return this.transition(estimateId, 'sent', Permission.SEND_ESTIMATES, userProfile, supabaseClient);
  }

  async acceptEstimate(
    estimateId: string,
    userProfile: UserWithRoles | null | undefined,
    supabaseClient?: AppSupabaseClient | null,
  ): Promise<EstimateRow> {
    return this.transition(
      estimateId,
      'accepted',
      Permission.ACCEPT_ESTIMATES,
      userProfile,
      supabaseClient,
    );
  }

  async rejectEstimate(
    estimateId: string,
    userProfile: UserWithRoles | null | undefined,
    supabaseClient?: AppSupabaseClient | null,
  ): Promise<EstimateRow> {
    return this.transition(
      estimateId,
      'rejected',
      Permission.REJECT_ESTIMATES,
      userProfile,
      supabaseClient,
    );
  }

  private async transition(
    estimateId: string,
    to: EstimateStatus,
    permission: Permission,
    userProfile: UserWithRoles | null | undefined,
    supabaseClient?: AppSupabaseClient | null,
  ): Promise<EstimateRow> {
    const supabase = this.resolveClient(supabaseClient);
    const current = await this.fetchEstimateRow(supabase, estimateId);

    await this.assertEstimateAccess(userProfile, permission, current, supabase);

    assertTransition(current.status, to);

    const { data, error } = await supabase
      .from('estimates')
      .update({ status: to })
      .eq('id', estimateId)
      .eq('status', current.status)
      .select()
      .maybeSingle();

    if (error) {
      this.mapDatabaseError(error, 'Failed to change estimate status');
    }

    if (!data) {
      // Someone else changed the row between our read and our write.
      const latest = await this.fetchEstimateRow(supabase, estimateId);
      throw new EstimateConflictError(
        `Estimate status changed concurrently (now ${latest.status}); expected ${current.status}`,
      );
    }

    return data as EstimateRow;
  }

  // NOTE: there is intentionally no delete method. Estimates are financial
  // records; rejected/accepted rows stay forever.
}

export const estimateService = new EstimateService();

/**
 * Allowlisted API representation of an estimate and its lines.
 *
 * Built by picking fields explicitly rather than spreading the row, so any
 * internal column added later (audit fields, internal notes, workflow ids)
 * is never exposed by accident.
 */
export function serializeEstimate(estimate: EstimateRow) {
  return {
    id: estimate.id,
    account_id: estimate.account_id,
    project_id: estimate.project_id,
    estimate_number: estimate.estimate_number,
    title: estimate.title,
    description: estimate.description,
    status: estimate.status,
    currency: estimate.currency,
    subtotal_minor: estimate.subtotal_minor,
    tax_minor: estimate.tax_minor,
    total_minor: estimate.total_minor,
    created_at: estimate.created_at,
    updated_at: estimate.updated_at,
  };
}

export function serializeEstimateWithItems(result: EstimateWithItems) {
  const { estimate, lineItems } = result;

  return {
    ...serializeEstimate(estimate),
    line_items: lineItems.map((line) => ({
      id: line.id,
      estimate_id: line.estimate_id,
      description: line.description,
      quantity: line.quantity,
      unit_price_minor: line.unit_price_minor,
      amount_minor: line.amount_minor,
      sort_order: line.sort_order,
    })),
  };
}

/**
 * TRANSACTION-SAFE UPGRADE (recommended, not implemented here):
 * wrap createEstimate's two inserts and replaceLineItems' delete+insert in
 * Postgres functions (e.g. `save_estimate_with_lines`) invoked via
 * `supabase.rpc(...)`, which gives real atomicity instead of compensation.
 * The service API would not need to change.
 */
