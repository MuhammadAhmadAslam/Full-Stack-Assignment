/**
 * Estimate payload validation — shape rules and authoritative totals.
 */
import { describe, it, expect } from 'vitest';
import {
  calculateEstimateValues,
  createEstimateSchema,
  estimateLineItemSchema,
  updateEstimateSchema,
} from '@/lib/validation-schemas';

const basePayload = {
  account_id: '11111111-1111-1111-1111-111111111111',
  estimate_number: 'EST-001',
  title: 'Website redesign',
  currency: 'USD',
  line_items: [
    { description: 'Discovery', quantity: '2.5', unit_price_minor: 12_000 },
    { description: 'Build', quantity: 3, unit_price_minor: 45_000 },
  ],
  tax_rate_bps: 825,
};

describe('createEstimateSchema', () => {
  it('accepts a valid payload', () => {
    const parsed = createEstimateSchema.safeParse(basePayload);
    expect(parsed.success).toBe(true);
  });

  it('rejects client-supplied totals and unknown fields', () => {
    for (const extra of [
      { subtotal_minor: 1 },
      { total_minor: 1 },
      { tax_minor: 0, status: 'accepted' },
      { created_by: '11111111-1111-1111-1111-111111111111' },
    ]) {
      const parsed = createEstimateSchema.safeParse({ ...basePayload, ...extra });
      expect(parsed.success, `should reject ${JSON.stringify(extra)}`).toBe(false);
    }
  });

  it('requires a UUID account_id', () => {
    expect(createEstimateSchema.safeParse({ ...basePayload, account_id: 'account-1' }).success).toBe(
      false,
    );
  });

  it('rejects an empty or whitespace-only title and number', () => {
    expect(createEstimateSchema.safeParse({ ...basePayload, title: '   ' }).success).toBe(false);
    expect(createEstimateSchema.safeParse({ ...basePayload, estimate_number: '' }).success).toBe(
      false,
    );
  });

  it('rejects invalid currency codes but normalises valid lower case', () => {
    ['US', 'USDD', '12A', 'us-dollar', ''].forEach((currency) => {
      expect(
        createEstimateSchema.safeParse({ ...basePayload, currency }).success,
        `currency ${currency}`,
      ).toBe(false);
    });
    const parsed = createEstimateSchema.safeParse({ ...basePayload, currency: 'usd' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.currency).toBe('USD');
  });
});

describe('estimateLineItemSchema', () => {
  it('rejects a blank description', () => {
    expect(
      estimateLineItemSchema.safeParse({ description: '   ', quantity: 1, unit_price_minor: 100 })
        .success,
    ).toBe(false);
  });

  it('rejects negative and fractional prices', () => {
    expect(
      estimateLineItemSchema.safeParse({ description: 'A', quantity: 1, unit_price_minor: -1 })
        .success,
    ).toBe(false);
    expect(
      estimateLineItemSchema.safeParse({ description: 'A', quantity: 1, unit_price_minor: 10.5 })
        .success,
    ).toBe(false);
  });

  it('rejects zero and over-precise quantities', () => {
    for (const quantity of [0, '0.000', '1.2345', '1e3']) {
      expect(
        estimateLineItemSchema.safeParse({ description: 'A', quantity, unit_price_minor: 100 })
          .success,
        `quantity ${quantity}`,
      ).toBe(false);
    }
  });

  it('rejects prices beyond the safe integer range', () => {
    expect(
      estimateLineItemSchema.safeParse({
        description: 'A',
        quantity: 1,
        unit_price_minor: Number.MAX_SAFE_INTEGER + 2,
      }).success,
    ).toBe(false);
  });
});

describe('calculateEstimateValues (server-authoritative totals)', () => {
  it('calculates from the validated lines, not from client totals', () => {
    const parsed = createEstimateSchema.safeParse(basePayload);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const result = calculateEstimateValues(parsed.data);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // 2.5 * 12000 = 30000 ; 3 * 45000 = 135000 ; subtotal 165000
    expect(result.value.lines.map((l) => l.amountMinor)).toEqual([30_000, 135_000]);
    expect(result.value.lines.map((l) => l.quantity)).toEqual(['2.500', '3.000']);
    expect(result.value.totals.subtotalMinor).toBe(165_000);
    expect(result.value.totals.taxMinor).toBe(13_613); // 13612.5 -> 13613
    expect(result.value.totals.totalMinor).toBe(178_613);
  });

  it('is deterministic for identical input', () => {
    const parsed = createEstimateSchema.parse(basePayload);
    const first = calculateEstimateValues(parsed);
    for (let i = 0; i < 10; i++) {
      expect(calculateEstimateValues(parsed)).toEqual(first);
    }
  });

  it('rejects tax_minor that contradicts tax_rate_bps', () => {
    const result = calculateEstimateValues({
      line_items: [{ description: 'A', quantity: 1, unit_price_minor: 10_000 }],
      tax_rate_bps: 1000,
      tax_minor: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_TAX');
  });

  it('rejects overflow instead of returning an imprecise total', () => {
    const result = calculateEstimateValues({
      line_items: [
        { description: 'A', quantity: 1, unit_price_minor: Number.MAX_SAFE_INTEGER },
      ],
      tax_minor: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('AMOUNT_OVERFLOW');
  });
});

describe('updateEstimateSchema', () => {
  it('accepts a partial header patch and a line replacement', () => {
    expect(updateEstimateSchema.safeParse({ title: 'Renamed' }).success).toBe(true);
    expect(
      updateEstimateSchema.safeParse({
        line_items: [{ description: 'Only line', quantity: '0.5', unit_price_minor: 5000 }],
      }).success,
    ).toBe(true);
    expect(updateEstimateSchema.safeParse({}).success).toBe(true);
  });

  it('still rejects totals and unknown fields', () => {
    expect(updateEstimateSchema.safeParse({ subtotal_minor: 10 }).success).toBe(false);
    expect(updateEstimateSchema.safeParse({ total_minor: 10 }).success).toBe(false);
  });
});
