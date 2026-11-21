/**
 * Parsers for money and percentage values typed into forms.
 *
 * Everything goes string → scaled integer, never `parseFloat(x) * 100`.
 * `parseFloat('0.07') * 100` is 7.0000000000000001; these parsers return
 * exactly 7, matching what the server stores.
 */

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

// Up to 13 integer digits so overflow is caught by the safe-integer check
// rather than by the regex.
const AMOUNT_PATTERN = /^\d{1,13}(\.\d{1,2})?$/;
const PERCENT_PATTERN = /^\d{1,3}(\.\d{1,2})?$/;

/**
 * "1200.50" -> 120050 minor units.
 * Rejects blank input, negatives, > 2 decimals, exponents and overflow.
 */
export function parseMajorToMinor(input: string | number | null | undefined): ParseResult<number> {
  const raw = typeof input === 'number' ? String(input) : (input ?? '').trim();

  if (raw === '') return { ok: false, error: 'Amount is required' };
  if (!AMOUNT_PATTERN.test(raw)) {
    return { ok: false, error: 'Use a positive amount with at most 2 decimals' };
  }

  const [major, fraction = ''] = raw.split('.');
  const minor = BigInt(major) * BigInt(100) + BigInt(fraction.padEnd(2, '0'));

  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) {
    return { ok: false, error: 'Amount is too large' };
  }

  return { ok: true, value: Number(minor) };
}

/** 120050 -> "1200.50" (for prefilling an input). */
export function formatMinorToMajor(minor: number): string {
  if (!Number.isSafeInteger(minor) || minor < 0) return '0.00';
  const major = Math.floor(minor / 100);
  const cents = minor % 100;
  return `${major}.${String(cents).padStart(2, '0')}`;
}

/**
 * "8.25" -> 825 basis points.
 * Rejects > 100%, negatives, exponents and > 2 decimals.
 */
export function parsePercentToBasisPoints(input: string | number | null | undefined): ParseResult<number> {
  const raw = typeof input === 'number' ? String(input) : (input ?? '').trim();

  if (raw === '') return { ok: true, value: 0 };
  if (!PERCENT_PATTERN.test(raw)) {
    return { ok: false, error: 'Tax rate must be 0–100 with at most 2 decimals' };
  }

  const [whole, fraction = ''] = raw.split('.');
  const bps = BigInt(whole) * BigInt(100) + BigInt(fraction.padEnd(2, '0'));

  if (bps > BigInt(10_000)) {
    return { ok: false, error: 'Tax rate cannot exceed 100%' };
  }

  return { ok: true, value: Number(bps) };
}

/** 825 -> "8.25". */
export function formatBasisPointsToPercent(bps: number): string {
  if (!Number.isSafeInteger(bps) || bps < 0) return '0.00';
  const whole = Math.floor(bps / 100);
  const fraction = bps % 100;
  return `${whole}.${String(fraction).padStart(2, '0')}`;
}
