/**
 * Estimates — integer minor-unit arithmetic.
 *
 * RULES (must stay in sync with supabase/schema.sql):
 *   * Money is an integer count of the currency's minor unit. No floats
 *     are ever multiplied or summed here.
 *   * quantity is NUMERIC(12,3). It is parsed from its decimal STRING
 *     form into a scaled integer ("milli-units": 1.250 -> 1250), so a
 *     float artifact such as 0.1 + 0.2 = 0.30000000000000004 is rejected
 *     instead of silently rounded.
 *   * Line rounding is half away from zero at 3 decimal places, which is
 *     exactly what PostgreSQL round(quantity * unit_price_minor) computes
 *     for the generated column estimate_line_items.amount_minor. The
 *     server value and the stored value therefore always agree.
 *   * Tax is a percentage expressed in BASIS POINTS (825 = 8.25%) and is
 *     rounded with the same half-away-from-zero rule, applied to the
 *     integer subtotal.
 *   * Every intermediate result is range-checked against
 *     Number.MAX_SAFE_INTEGER, because amounts cross the JSON boundary as
 *     IEEE-754 doubles; past that limit they would silently lose precision.
 *
 * Nothing in this module reads a database, a clock or a random source, so
 * identical inputs always produce identical totals.
 */

/** Largest amount we accept: JSON numbers stay exact only up to 2^53-1. */
export const MAX_MINOR_UNITS = Number.MAX_SAFE_INTEGER;

/** quantity has 3 decimal places in the database. */
export const QUANTITY_DECIMAL_PLACES = 3;
// NOTE: BigInt() rather than 1000n — tsconfig targets ES2017, where bigint
// literals are a compile error, while BigInt itself is available at runtime
// (Node 20+ and every browser the app supports).
export const QUANTITY_SCALE = BigInt(1000);

/** Database CHECK: quantity > 0 AND quantity <= 1000000. */
export const MAX_QUANTITY = 1_000_000;
const MAX_QUANTITY_MILLI = BigInt(1_000_000_000);

/** 100.00% in basis points. */
export const MAX_TAX_RATE_BPS = 10_000;

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

export type MoneyErrorCode =
  | 'INVALID_QUANTITY'
  | 'INVALID_PRICE'
  | 'INVALID_TAX'
  | 'INVALID_LINE_SET'
  | 'AMOUNT_OVERFLOW';

export interface MoneyError {
  code: MoneyErrorCode;
  message: string;
}

export type MoneyResult<T> = { ok: true; value: T } | { ok: false; error: MoneyError };

const fail = (code: MoneyErrorCode, message: string): { ok: false; error: MoneyError } => ({
  ok: false,
  error: { code, message },
});

/**
 * Exact division by a power of ten with half-away-from-zero rounding.
 * Inputs are non-negative by construction; the sign branch is kept so the
 * helper stays correct if reuse ever introduces negative values.
 */
function divideRoundHalfAwayFromZero(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < BigInt(0);
  const n = negative ? -numerator : numerator;
  const quotient = n / denominator;
  const remainder = n % denominator;
  const rounded =
    remainder * BigInt(2) >= denominator ? quotient + BigInt(1) : quotient;
  return negative ? -rounded : rounded;
}

/**
 * Parse a quantity (number or decimal string) into scaled milli-units.
 * Accepts at most 3 decimal places and values in (0, 1_000_000].
 */
export function parseQuantityToMilli(input: unknown): MoneyResult<bigint> {
  let raw: string;

  if (typeof input === 'number') {
    if (!Number.isFinite(input)) {
      return fail('INVALID_QUANTITY', 'Quantity must be a finite number');
    }
    raw = String(input);
  } else if (typeof input === 'string') {
    raw = input.trim();
  } else {
    return fail('INVALID_QUANTITY', 'Quantity must be a number or a decimal string');
  }

  if (raw.length === 0) {
    return fail('INVALID_QUANTITY', 'Quantity is required');
  }

  if (/[eE]/.test(raw)) {
    return fail(
      'INVALID_QUANTITY',
      'Quantity must be written in plain decimal notation (exponent notation is not accepted)',
    );
  }

  // Positive decimals only: no sign, no leading '.', at most 3 decimals.
  const match = /^(\d{1,9})(?:\.(\d{1,3}))?$/.exec(raw);
  if (!match) {
    return fail(
      'INVALID_QUANTITY',
      'Quantity must be a positive decimal with at most 3 decimal places',
    );
  }

  const fraction = (match[2] ?? '').padEnd(QUANTITY_DECIMAL_PLACES, '0');
  const milli = BigInt(match[1]) * QUANTITY_SCALE + BigInt(fraction || '0');

  if (milli <= BigInt(0)) {
    return fail('INVALID_QUANTITY', 'Quantity must be greater than zero');
  }

  if (milli > MAX_QUANTITY_MILLI) {
    return fail('INVALID_QUANTITY', `Quantity must not exceed ${MAX_QUANTITY}`);
  }

  return { ok: true, value: milli };
}

/** Render scaled milli-units back to a fixed 3-decimal string ("1.500"). */
export function formatQuantity(milli: bigint): string {
  const whole = milli / QUANTITY_SCALE;
  const fraction = (milli % QUANTITY_SCALE).toString().padStart(QUANTITY_DECIMAL_PLACES, '0');
  return `${whole}.${fraction}`;
}

/**
 * Line amount = round(quantity * unit_price_minor), computed in BigInt.
 * Mirrors the generated column in the database.
 */
export function computeLineAmountMinor(
  quantityMilli: bigint,
  unitPriceMinor: number,
): MoneyResult<bigint> {
  if (!Number.isInteger(unitPriceMinor) || unitPriceMinor < 0) {
    return fail('INVALID_PRICE', 'Unit price must be a non-negative integer in minor units');
  }

  if (!Number.isSafeInteger(unitPriceMinor)) {
    return fail('INVALID_PRICE', 'Unit price exceeds the safe integer range');
  }

  if (quantityMilli <= BigInt(0)) {
    return fail('INVALID_QUANTITY', 'Quantity must be greater than zero');
  }

  const amount = divideRoundHalfAwayFromZero(quantityMilli * BigInt(unitPriceMinor), QUANTITY_SCALE);

  if (amount > MAX_SAFE_BIGINT) {
    return fail('AMOUNT_OVERFLOW', 'Line amount exceeds the safe integer range');
  }

  return { ok: true, value: amount };
}

/** Sum integer amounts, rejecting negative values and overflow. */
export function sumMinorUnits(amounts: readonly number[]): MoneyResult<number> {
  let total = BigInt(0);

  for (const amount of amounts) {
    if (!Number.isSafeInteger(amount) || amount < 0) {
      return fail('INVALID_LINE_SET', 'Line amounts must be non-negative integers');
    }
    total += BigInt(amount);
    if (total > MAX_SAFE_BIGINT) {
      return fail('AMOUNT_OVERFLOW', 'Subtotal exceeds the safe integer range');
    }
  }

  return { ok: true, value: Number(total) };
}

/**
 * Tax from basis points, rounded half away from zero.
 * 12345 at 825 bps (8.25%) -> 1018 (1018.4625 rounds down);
 * 12345 at 1000 bps (10%)  -> 1235 (1234.5 rounds up).
 */
export function computeTaxMinorFromBasisPoints(
  subtotalMinor: number,
  rateBps: number,
): MoneyResult<number> {
  if (!Number.isSafeInteger(subtotalMinor) || subtotalMinor < 0) {
    return fail('INVALID_TAX', 'Subtotal must be a non-negative integer in minor units');
  }

  if (!Number.isInteger(rateBps) || rateBps < 0 || rateBps > MAX_TAX_RATE_BPS) {
    return fail('INVALID_TAX', `Tax rate must be an integer between 0 and ${MAX_TAX_RATE_BPS} bps`);
  }

  const tax = divideRoundHalfAwayFromZero(
    BigInt(subtotalMinor) * BigInt(rateBps),
    BigInt(10_000),
  );

  if (tax > MAX_SAFE_BIGINT) {
    return fail('AMOUNT_OVERFLOW', 'Tax exceeds the safe integer range');
  }

  return { ok: true, value: Number(tax) };
}

export interface EstimateLineInput {
  description: string;
  quantity: unknown;
  unit_price_minor: number;
  sort_order?: number;
}

export interface ComputedEstimateLine {
  description: string;
  /** Fixed 3-decimal string, ready to persist into NUMERIC(12,3). */
  quantity: string;
  quantityMilli: number;
  unitPriceMinor: number;
  amountMinor: number;
  sortOrder: number;
}

export interface ComputedEstimateTotals {
  subtotalMinor: number;
  taxMinor: number;
  totalMinor: number;
}

export interface ComputedEstimate {
  lines: ComputedEstimateLine[];
  totals: ComputedEstimateTotals;
}

export interface EstimateTotalsOptions {
  /** Explicit tax amount in minor units. */
  taxMinor?: number;
  /** Tax rate in basis points; when provided, tax is calculated from it. */
  taxRateBps?: number;
}

/**
 * Authoritative calculation for one estimate.
 *
 * The caller supplies raw line inputs and an optional tax instruction; the
 * returned subtotal/total are the only values that may be persisted. A
 * client-supplied subtotal or total is never an input here.
 */
export function computeEstimate(
  rawLines: readonly EstimateLineInput[],
  options: EstimateTotalsOptions = {},
): MoneyResult<ComputedEstimate> {
  const lines: ComputedEstimateLine[] = [];
  const amountMinorList: number[] = [];

  for (let index = 0; index < rawLines.length; index++) {
    const raw = rawLines[index];

    const quantity = parseQuantityToMilli(raw.quantity);
    if (!quantity.ok) return { ok: false, error: quantity.error };

    const amount = computeLineAmountMinor(quantity.value, raw.unit_price_minor);
    if (!amount.ok) return { ok: false, error: amount.error };

    lines.push({
      description: raw.description,
      quantity: formatQuantity(quantity.value),
      quantityMilli: Number(quantity.value),
      unitPriceMinor: raw.unit_price_minor,
      amountMinor: Number(amount.value),
      sortOrder: raw.sort_order ?? index,
    });
    amountMinorList.push(Number(amount.value));
  }

  const subtotal = sumMinorUnits(amountMinorList);
  if (!subtotal.ok) return { ok: false, error: subtotal.error };

  let taxMinor = 0;

  if (options.taxRateBps !== undefined) {
    const calculated = computeTaxMinorFromBasisPoints(subtotal.value, options.taxRateBps);
    if (!calculated.ok) return { ok: false, error: calculated.error };

    if (options.taxMinor !== undefined && options.taxMinor !== calculated.value) {
      return fail(
        'INVALID_TAX',
        `tax_minor (${options.taxMinor}) does not match the tax rate (expected ${calculated.value})`,
      );
    }

    taxMinor = calculated.value;
  } else if (options.taxMinor !== undefined) {
    if (!Number.isSafeInteger(options.taxMinor) || options.taxMinor < 0) {
      return fail('INVALID_TAX', 'Tax must be a non-negative integer in minor units');
    }
    taxMinor = options.taxMinor;
  }

  const total = BigInt(subtotal.value) + BigInt(taxMinor);
  if (total > MAX_SAFE_BIGINT) {
    return fail('AMOUNT_OVERFLOW', 'Total exceeds the safe integer range');
  }

  return {
    ok: true,
    value: {
      lines,
      totals: {
        subtotalMinor: subtotal.value,
        taxMinor,
        totalMinor: Number(total),
      },
    },
  };
}
