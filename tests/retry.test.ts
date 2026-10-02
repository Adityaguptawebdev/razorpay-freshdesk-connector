import { describe, expect, it } from 'vitest';
import { backoffDelay, parseRetryAfter } from '../src/utils/retry.js';
import { FIXED_NOW } from './fixtures/tickets.js';

describe('parseRetryAfter', () => {
  it('parses delta-seconds (the format Freshdesk uses)', () => {
    expect(parseRetryAfter('30', FIXED_NOW)).toBe(30_000);
    expect(parseRetryAfter(' 2 ', FIXED_NOW)).toBe(2_000);
    expect(parseRetryAfter('0', FIXED_NOW)).toBe(0);
  });

  it('parses an HTTP-date relative to now', () => {
    expect(parseRetryAfter('Fri, 02 Oct 2026 10:00:45 GMT', FIXED_NOW)).toBe(45_000);
  });

  it('clamps HTTP-dates in the past to zero', () => {
    expect(parseRetryAfter('Fri, 02 Oct 2026 09:00:00 GMT', FIXED_NOW)).toBe(0);
  });

  it.each([null, '', 'soon', '-5', '1.5', 'NaN'])('returns undefined for %j', (value) => {
    expect(parseRetryAfter(value, FIXED_NOW)).toBeUndefined();
  });
});

describe('backoffDelay', () => {
  const policy = { baseDelayMs: 1_000, maxDelayMs: 30_000 };

  it('doubles the delay on each retry', () => {
    const delays = [0, 1, 2, 3].map((retry) => backoffDelay(retry, policy, () => 1));
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000]);
  });

  it('applies equal jitter between half and the full delay', () => {
    expect(backoffDelay(2, policy, () => 0)).toBe(2_000);
    expect(backoffDelay(2, policy, () => 0.5)).toBe(3_000);
  });

  it('never exceeds maxDelayMs', () => {
    expect(backoffDelay(20, policy, () => 1)).toBe(30_000);
  });
});
