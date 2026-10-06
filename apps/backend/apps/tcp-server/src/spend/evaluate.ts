import type { CapLimit } from './spend-caps.config';

/** Progress against one limit; `thresholds` lists every notifyAt percentage already passed (plus 100 when reached) — callers dedupe. */
export interface LimitProgress {
  limit: CapLimit;
  used: number;
  percent: number;
  reached: boolean;
  thresholds: number[];
}

/** How far `used` tokens have progressed `limit`, and which notifyAt thresholds it has already crossed. */
export function evaluateLimit(
  limit: CapLimit,
  used: number,
  notifyAt: number[],
): LimitProgress {
  const percent = Math.floor((used * 100) / limit.tokens);
  const reached = used >= limit.tokens;
  const crossed = notifyAt
    .filter((pct) => pct <= percent)
    .sort((a, b) => a - b);
  const thresholds = reached ? [...crossed, 100] : crossed;
  return { limit, used, percent, reached, thresholds };
}
