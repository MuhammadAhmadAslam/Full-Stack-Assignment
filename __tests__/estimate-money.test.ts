/**
 * Money layer tests — exact integer arithmetic, explicit rounding, overflow.
 * These are the guarantees the estimates API relies on.
 */
import { describe, it, expect } from 'vitest';
import {
  computeEstimate,
  computeLineAmountMinor,
  computeTaxMinorFromBasisPoints,
  formatQuantity,
  parseQuantityToMilli,
  sumMinorUnits,
  MAX_MINOR_UNITS,
  MAX_QUANTITY,
} from '@/lib/estimate-money';

const milliOf = (input: unknown): bigint => {
  const parsed = parseQuantityToMilli(input);
  if (!parsed.ok) throw new Error(`expected valid quantity: ${parsed.error.message}`);
  return parsed.value;
};

describe('parseQuantityToMilli', () => {
  it('parses integers, decimals and string forms exactly', () => {
    expect(milliOf('1')).toBe(1000n);
    expect(milliOf('1.5')).toBe(1500n);
    expect(milliOf('1.500')).toBe(1500n);
    expect(milliOf('0.001')).toBe(1n);
    expect(milliOf(2.25)).toBe(2250n);
    expect(milliOf('000123.456')).toBe(123456n);
  });

  it('rejects zero, negatives, exponents and more than 3 decimals', () => {
    for (const bad of ['0', '0.000', '-1', '-0.5', '1e3', '1.2345', '.5', '+1', '', '  ', 'abc']) {
      expect(parseQuantityToMilli(bad).ok, `should reject ${JSON.stringify(bad)}`).toBe(false);
    }
    expect(parseQuantityToMilli(0).ok).toBe(false);
    expect(parseQuantityToMilli(-0.5).ok).toBe(false);
    expect(parseQuantityToMilli(NaN).ok).toBe(false);
    expect(parseQuantityToMilli(Infinity).ok).toBe(false);
    expect(parseQuantityToMilli(null).ok).toBe(false);
  });

  it('rejects the float artifact 0.1 + 0.2 instead of silently rounding it', () => {
    // String(0.1 + 0.2) === '0.30000000000000004' — 17 decimals.
    expect(parseQuantityToMilli(0.1 + 0.2).ok).toBe(false);
    // The exact decimal the user meant is accepted.
    expect(milliOf('0.3')).toBe(300n);
  });

  it('enforces the database quantity ceiling', () => {
    expect(milliOf(String(MAX_QUANTITY))).toBe(1_000_000_000n);
    expect(parseQuantityToMilli(String(MAX_QUANTITY + 1)).ok).toBe(false);
  });

  it('renders a fixed 3-decimal string', () => {
    expect(formatQuantity(1500n)).toBe('1.500');
    expect(formatQuantity(1n)).toBe('0.001');
    expect(formatQuantity(1_000_000_000n)).toBe('1000000.000');
  });
});

describe('computeLineAmountMinor', () => {
  it('matches PostgreSQL round(quantity * unit_price_minor)', () => {
    expect(computeLineAmountMinor(1500n, 10_000)).toEqual({ ok: true, value: 15_000n });
    expect(computeLineAmountMinor(333n, 100)).toEqual({ ok: true, value: 33n }); // 33.3 -> 33
    expect(computeLineAmountMinor(335n, 100)).toEqual({ ok: true, value: 34n }); // 33.5 -> 34 (half up)
    expect(computeLineAmountMinor(1005n, 1000)).toEqual({ ok: true, value: 1005n });
    expect(computeLineAmountMinor(2500n, 3)).toEqual({ ok: true, value: 8n }); // 7.5 -> 8
    expect(computeLineAmountMinor(1n, 500)).toEqual({ ok: true, value: 1n }); // 0.5 -> 1
    expect(computeLineAmountMinor(1n, 499)).toEqual({ ok: true, value: 0n }); // 0.499 -> 0
  });

  it('allows a zero price but not a negative or fractional one', () => {
    expect(computeLineAmountMinor(1500n, 0)).toEqual({ ok: true, value: 0n });
    expect(computeLineAmountMinor(1500n, -1).ok).toBe(false);
    expect(computeLineAmountMinor(1500n, 1.5).ok).toBe(false);
  });

  it('rejects amounts beyond the safe integer range', () => {
    const result = computeLineAmountMinor(2_000_000n, MAX_MINOR_UNITS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('AMOUNT_OVERFLOW');
  });
});

describe('subtotal and tax', () => {
  it('sums integer amounts without drift', () => {
    expect(sumMinorUnits([10, 20, 30])).toEqual({ ok: true, value: 60 });
    expect(sumMinorUnits([])).toEqual({ ok: true, value: 0 });
    expect(sumMinorUnits([1, -1]).ok).toBe(false);
    expect(sumMinorUnits([1.5]).ok).toBe(false);
  });

  it('rejects subtotal overflow', () => {
    expect(sumMinorUnits([MAX_MINOR_UNITS, 1]).ok).toBe(false);
  });

  it('rounds tax from basis points half away from zero', () => {
    expect(computeTaxMinorFromBasisPoints(12_345, 825)).toEqual({ ok: true, value: 1018 }); // 1018.4625
    expect(computeTaxMinorFromBasisPoints(12_345, 1000)).toEqual({ ok: true, value: 1235 }); // 1234.5
    expect(computeTaxMinorFromBasisPoints(12_345, 0)).toEqual({ ok: true, value: 0 });
    expect(computeTaxMinorFromBasisPoints(100, 5000)).toEqual({ ok: true, value: 50 });
  });

  it('rejects invalid tax rates', () => {
    expect(computeTaxMinorFromBasisPoints(100, -1).ok).toBe(false);
    expect(computeTaxMinorFromBasisPoints(100, 10_001).ok).toBe(false);
    expect(computeTaxMinorFromBasisPoints(100, 825.5).ok).toBe(false);
  });
});

describe('computeEstimate', () => {
  it('calculates lines, subtotal, tax and total', () => {
    const result = computeEstimate(
      [
        { description: 'Design', quantity: '1.5', unit_price_minor: 10_000 },
        { description: 'Build', quantity: 2, unit_price_minor: 25_000 },
      ],
      { taxRateBps: 825 },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.lines.map((l) => l.amountMinor)).toEqual([15_000, 50_000]);
    expect(result.value.lines[0].quantity).toBe('1.500');
    expect(result.value.totals).toEqual({
      subtotalMinor: 65_000,
      taxMinor: 5363, // 65000 * 8.25% = 5362.5 -> 5363
      totalMinor: 70_363,
    });
  });

  it('is deterministic across repeated calls', () => {
    const run = () =>
      computeEstimate(
        [
          { description: 'A', quantity: '0.333', unit_price_minor: 100 },
          { description: 'B', quantity: '123456.789', unit_price_minor: 9973 },
        ],
        { taxRateBps: 725 },
      );

    const first = run();
    expect(first.ok).toBe(true);
    for (let i = 0; i < 25; i++) {
      expect(run()).toEqual(first);
    }
  });

  it('rejects a tax_minor that disagrees with tax_rate_bps', () => {
    const result = computeEstimate([{ description: 'A', quantity: 1, unit_price_minor: 1000 }], {
      taxRateBps: 1000,
      taxMinor: 99,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_TAX');
  });

  it('accepts an explicit tax_minor when no rate is given', () => {
    const result = computeEstimate([{ description: 'A', quantity: 1, unit_price_minor: 1000 }], {
      taxMinor: 180,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.totals.totalMinor).toBe(1180);
  });

  it('rejects a negative tax amount', () => {
    expect(
      computeEstimate([{ description: 'A', quantity: 1, unit_price_minor: 1000 }], { taxMinor: -5 }).ok,
    ).toBe(false);
  });

  it('allows an empty draft (zero totals)', () => {
    const result = computeEstimate([], {});
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.totals.totalMinor).toBe(0);
  });

  it('rejects total overflow', () => {
    const result = computeEstimate(
      [{ description: 'A', quantity: 1, unit_price_minor: MAX_MINOR_UNITS }],
      { taxMinor: 1 },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('AMOUNT_OVERFLOW');
  });

  it('rejects an invalid quantity inside a line', () => {
    const result = computeEstimate([{ description: 'A', quantity: '1.2345', unit_price_minor: 100 }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_QUANTITY');
  });
});
