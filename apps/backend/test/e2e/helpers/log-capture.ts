import { Logger } from '@nestjs/common';

export type CapturedLogLevel = 'log' | 'warn' | 'error';

export interface CapturedLog {
  level: CapturedLogLevel;
  message: string;
}

export interface LogCapture {
  /** Logs recorded since {@link captureNestLogs} was called, in order. */
  logs: CapturedLog[];
  /** Restores the original `Logger` methods (real console output resumes). */
  restore(): void;
}

/**
 * Silences and records `Logger.warn`/`Logger.error`/`Logger.log` calls made
 * through any NestJS `Logger` instance for the duration of a test — used to
 * keep intentionally-triggered error paths (e.g. `POST /internal/agent/:id/fail`)
 * from spamming test output, while still letting a test assert the log happened.
 *
 * Call `restore()` in an `afterEach`/`finally` so later tests see real logs again.
 */
export function captureNestLogs(): LogCapture {
  const logs: CapturedLog[] = [];
  const levels: CapturedLogLevel[] = ['log', 'warn', 'error'];
  const spies = levels.map((level) =>
    jest
      .spyOn(Logger.prototype, level)
      .mockImplementation((message: unknown) => {
        logs.push({ level, message: String(message) });
      }),
  );
  return {
    logs,
    restore: () => spies.forEach((spy) => spy.mockRestore()),
  };
}

/**
 * Asserts that at least one captured log's message contains (string) or
 * matches (RegExp) `keyword`. Deliberately a substring/pattern search rather
 * than an exact match — log wording is free to change without breaking tests
 * that only care that *an* error about the right thing was logged.
 */
export function expectLoggedError(
  logs: CapturedLog[],
  keyword: string | RegExp,
): void {
  const found = logs.some((entry) =>
    typeof keyword === 'string'
      ? entry.message.includes(keyword)
      : keyword.test(entry.message),
  );
  if (!found) {
    throw new Error(
      `Expected a captured log matching ${String(keyword)}, but got: ${JSON.stringify(logs)}`,
    );
  }
}
