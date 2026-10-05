import type { CapAction, CapDismissal } from '../models/SpendCapState.model';

/** Input and output tokens, summed. Field names follow OpenTelemetry's `gen_ai.usage.*`. */
export interface TokenTotals {
  inputTokens: number;
  outputTokens: number;
}

/** One provider's usage since tracking began. */
export interface ProviderUsage extends TokenTotals {
  provider: string;
}

/** Progress against one configured limit, within its current window. */
export interface CapLimitReport {
  tokens: number;
  /** `month`, `week`, `day` (UTC calendar periods), or a stint like `5h`. */
  per: string;
  /** Tokens used in the current window. */
  used: number;
  /** `used` as a whole percentage of `tokens`; may exceed 100. */
  percent: number;
  /** ISO start of the current window; null for a stint not yet started. */
  windowStart: string | null;
  /** ISO end of the current window, when the limit resets; null for a stint not yet started. */
  resetsAt: string | null;
}

/** A provider's configured cap and where usage stands against it. */
export interface CapReport {
  provider: string;
  action: CapAction;
  dismissal: CapDismissal;
  /** True while a limit is reached and the cap is not dismissed — work is being held back. */
  holding: boolean;
  /** ISO end of the reached window; null when no limit is reached. */
  reachedUntil: string | null;
  limits: CapLimitReport[];
}

/** `GET /api/spend`: application-wide usage and every configured cap. */
export interface SpendOverview {
  /** ISO time of the first recorded usage; null before any. */
  trackingSince: string | null;
  providers: ProviderUsage[];
  caps: CapReport[];
}

/** `POST /api/task/:id/resume` and `POST /api/company/:id/resume`. */
export interface ResumeResult {
  /** Agents a resume was requested for. */
  resumed: number;
}

/** One task's usage. */
export interface TaskUsage extends TokenTotals {
  taskId: string;
}

/** One active five-minute period's usage. */
export interface UsageBucket extends TokenTotals {
  /** ISO start of the five-minute period. */
  bucketStart: string;
}

/** `GET /api/company/:id/spend`: one company's usage. */
export interface CompanySpend {
  /** ISO time of the company's first recorded usage; null before any. */
  trackingSince: string | null;
  providers: ProviderUsage[];
  /** Usage per task, largest total first. Usage outside any task (chats) is in `providers` only. */
  tasks: TaskUsage[];
  /** The last 24 hours in five-minute buckets, oldest first; only buckets with usage appear. */
  series: UsageBucket[];
}
