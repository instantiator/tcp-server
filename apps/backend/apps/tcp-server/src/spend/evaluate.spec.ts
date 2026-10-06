import { evaluateLimit } from './evaluate';
import type { CapLimit } from './spend-caps.config';

describe('evaluateLimit', () => {
  const limit: CapLimit = { tokens: 1000, per: 'day' };

  it('reports progress below every threshold', () => {
    const result = evaluateLimit(limit, 100, [50, 80]);
    expect(result).toEqual({
      limit,
      used: 100,
      percent: 10,
      reached: false,
      thresholds: [],
    });
  });

  it('reports thresholds crossed but not yet reached', () => {
    const result = evaluateLimit(limit, 600, [50, 80]);
    expect(result.percent).toBe(60);
    expect(result.reached).toBe(false);
    expect(result.thresholds).toEqual([50]);
  });

  it('includes a threshold crossed exactly', () => {
    const result = evaluateLimit(limit, 500, [50, 80]);
    expect(result.percent).toBe(50);
    expect(result.thresholds).toEqual([50]);
  });

  it('marks the limit reached and adds 100 to thresholds', () => {
    const result = evaluateLimit(limit, 1000, [50, 80]);
    expect(result.reached).toBe(true);
    expect(result.thresholds).toEqual([50, 80, 100]);
  });

  it('allows percent to exceed 100 when usage overshoots', () => {
    const result = evaluateLimit(limit, 1200, [50, 80]);
    expect(result.percent).toBe(120);
    expect(result.reached).toBe(true);
    expect(result.thresholds).toEqual([50, 80, 100]);
  });
});
