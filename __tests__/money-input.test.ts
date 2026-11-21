import { describe, it, expect } from 'vitest';
import {
  formatBasisPointsToPercent,
  formatMinorToMajor,
  parseMajorToMinor,
  parsePercentToBasisPoints,
} from '@/lib/money-input';

const minor = (input: string) => {
  const result = parseMajorToMinor(input);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};

describe('parseMajorToMinor', () => {
  it('parses decimal money exactly', () => {
    expect(minor('0')).toBe(0);
    expect(minor('0.01')).toBe(1);
    expect(minor('1200.5')).toBe(120050);
    expect(minor('1200.50')).toBe(120050);
    expect(minor('0.07')).toBe(7); // NOT 7.0000000000000001
    expect(minor('19.99')).toBe(1999);
    expect(minor('  42.00  ')).toBe(4200);
  });

  it('rejects malformed and out-of-range amounts', () => {
    for (const bad of ['', ' ', 'abc', '-1', '1.234', '.5', '1.', '+2', '1e3', '1,50']) {
      expect(parseMajorToMinor(bad).ok, bad).toBe(false);
    }
    // 14 integer digits cannot be represented as safe minor units.
    expect(parseMajorToMinor('90071992547409.92').ok).toBe(false);
    // The largest 13-digit amount still fits: 9_999_999_999_999.99 -> 999_999_999_999_999.
    expect(parseMajorToMinor('9999999999999.99')).toEqual({
      ok: true,
      value: 999_999_999_999_999,
    });
  });

  it('round-trips through the formatter', () => {
    expect(formatMinorToMajor(120050)).toBe('1200.50');
    expect(formatMinorToMajor(5)).toBe('0.05');
    expect(formatMinorToMajor(0)).toBe('0.00');
  });
});

describe('parsePercentToBasisPoints', () => {
  it('parses percentages exactly', () => {
    expect(parsePercentToBasisPoints('')).toEqual({ ok: true, value: 0 });
    expect(parsePercentToBasisPoints('0')).toEqual({ ok: true, value: 0 });
    expect(parsePercentToBasisPoints('8.25')).toEqual({ ok: true, value: 825 });
    expect(parsePercentToBasisPoints('8.5')).toEqual({ ok: true, value: 850 });
    expect(parsePercentToBasisPoints('100')).toEqual({ ok: true, value: 10000 });
  });

  it('rejects invalid percentages', () => {
    expect(parsePercentToBasisPoints('100.01').ok).toBe(false);
    expect(parsePercentToBasisPoints('8.255').ok).toBe(false);
    expect(parsePercentToBasisPoints('-5').ok).toBe(false);
    expect(parsePercentToBasisPoints('abc').ok).toBe(false);
  });

  it('round-trips through the formatter', () => {
    expect(formatBasisPointsToPercent(825)).toBe('8.25');
    expect(formatBasisPointsToPercent(50)).toBe('0.50');
    expect(formatBasisPointsToPercent(10000)).toBe('100.00');
  });
});
