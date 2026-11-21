/**
 * Idempotency primitives.
 *
 * This module only produces the key and the request fingerprint; the
 * duplicate decision itself is made by the database
 * (unique (user_id, account_id, idempotency_key) + the transactional
 * create_estimate_idempotent function). Nothing here caches or remembers
 * keys — an in-memory map would not survive multiple server instances and
 * would lose the race it is supposed to prevent.
 *
 * RETENTION: records live for 30 days
 * (supabase/migrations/20261121000000_create_idempotency_keys.sql,
 * purge_expired_idempotency_keys). After that a replayed key is treated as
 * a brand-new request.
 */

import { createHash } from 'node:crypto';

export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
export const IDEMPOTENCY_KEY_MIN_LENGTH = 8;
export const IDEMPOTENCY_KEY_MAX_LENGTH = 255;
export const IDEMPOTENCY_RETENTION_DAYS = 30;

/**
 * Printable-ASCII safe subset (RFC 7230 token characters commonly used for
 * UUIDs, ULIDs and prefixed keys). Matches the DB CHECK constraint.
 */
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,255}$/;

export type IdempotencyOutcome = 'created' | 'replay' | 'conflict';

export class IdempotencyKeyError extends Error {
  readonly status = 400;
  readonly code = 'IDEMPOTENCY_KEY_INVALID';

  constructor(message = 'Invalid Idempotency-Key header') {
    super(message);
    this.name = 'IdempotencyKeyError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Header reader that also accepts NextRequest/Request. */
export function readIdempotencyKeyHeader(
  request: { headers: { get(name: string): string | null } } | null | undefined,
): string | null {
  if (!request) return null;
  try {
    return request.headers.get(IDEMPOTENCY_KEY_HEADER);
  } catch {
    return null;
  }
}

export function isIdempotencyKeyValid(raw: string): boolean {
  return IDEMPOTENCY_KEY_PATTERN.test(raw);
}

/**
 * Trims and validates a raw header value.
 *   - absent/blank  -> null (caller decides whether the key is required)
 *   - malformed     -> IdempotencyKeyError (400)
 */
export function normalizeIdempotencyKey(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;

  const trimmed = raw.trim();
  if (trimmed === '') return null;

  if (!IDEMPOTENCY_KEY_PATTERN.test(trimmed)) {
    throw new IdempotencyKeyError(
      `Idempotency-Key must be ${IDEMPOTENCY_KEY_MIN_LENGTH}-${IDEMPOTENCY_KEY_MAX_LENGTH} characters of [A-Za-z0-9._:-]`,
    );
  }

  return trimmed;
}

/**
 * Deterministic JSON: object keys are sorted, array order is preserved,
 * `undefined` is dropped. Two payloads that describe the same request
 * therefore hash identically regardless of property order.
 */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new IdempotencyKeyError('Cannot fingerprint a non-finite number');
    }
    return JSON.stringify(value);
  }

  if (typeof value === 'bigint') return JSON.stringify(value.toString());

  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(',')}}`;
  }

  throw new IdempotencyKeyError(`Cannot fingerprint value of type ${typeof value}`);
}

/** SHA-256 hex (64 chars) — the `request_hash` stored in the database. */
export function computeRequestFingerprint(payload: unknown): string {
  return createHash('sha256').update(stableStringify(payload), 'utf8').digest('hex');
}
