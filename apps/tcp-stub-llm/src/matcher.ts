import type {
  ResolvedStubLlmConfig,
  ResponseGroup,
  StubResponse,
} from './config.ts';

/** Why no response could be selected. */
export type MatchFailureReason = 'no-match' | 'exhausted';

export type MatchOutcome =
  | { ok: true; response: StubResponse }
  | { ok: false; reason: MatchFailureReason };

/**
 * Per-rule response cursors, keyed by rule identity rather than array index so
 * a config reload (which replaces the array) starts every rule fresh.
 */
export class MatcherState {
  private readonly cursors = new Map<string, number>();

  cursorFor(key: string): number {
    return this.cursors.get(key) ?? 0;
  }

  advance(key: string): void {
    this.cursors.set(key, this.cursorFor(key) + 1);
  }

  reset(): void {
    this.cursors.clear();
  }
}

function matches(pattern: string, text: string): boolean {
  return new RegExp(pattern).test(text);
}

function selectFromGroup(
  group: ResponseGroup,
  cursorKey: string,
  state: MatcherState,
): MatchOutcome {
  const { responses, mode = 'sequence' } = group;
  if (responses.length === 0) {
    return { ok: false, reason: 'exhausted' };
  }

  if (mode === 'random') {
    const response = responses[Math.floor(Math.random() * responses.length)];
    return response
      ? { ok: true, response }
      : { ok: false, reason: 'exhausted' };
  }

  const cursor = state.cursorFor(cursorKey);
  const index = mode === 'loop' ? cursor % responses.length : cursor;
  if (index >= responses.length) {
    return { ok: false, reason: 'exhausted' };
  }
  const response = responses[index];
  if (!response) {
    return { ok: false, reason: 'exhausted' };
  }
  state.advance(cursorKey);
  return { ok: true, response };
}

/**
 * Picks a response for `promptText`: the first matching rule (in config
 * order), falling back to `defaults`, per the modes described in
 * `docs/stub-llm.md`.
 */
export function pickResponse(
  promptText: string,
  config: ResolvedStubLlmConfig,
  state: MatcherState,
): MatchOutcome {
  for (let i = 0; i < config.prompts.length; i++) {
    const rule = config.prompts[i];
    if (rule && matches(rule.match, promptText)) {
      return selectFromGroup(rule, `prompt:${i}`, state);
    }
  }
  if (config.defaults) {
    return selectFromGroup(config.defaults, 'defaults', state);
  }
  return { ok: false, reason: 'no-match' };
}
