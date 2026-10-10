import { useSyncExternalStore } from 'react';

/**
 * Which reasoning entries start open: every one, none, or only the newest.
 * The user can still open or close any single entry; a change of rule resets
 * those choices (000.06).
 */
export type ReasoningRule = 'all' | 'none' | 'latest';

export const REASONING_RULES: readonly ReasoningRule[] = [
  'all',
  'none',
  'latest',
];

/** A per-viewer preference, so it lives in the browser rather than on the server. */
export const REASONING_RULE_STORAGE_KEY = 'tcp.transcript.reasoning';

const DEFAULT_RULE: ReasoningRule = 'latest';

const isRule = (value: unknown): value is ReasoningRule =>
  REASONING_RULES.some((rule) => rule === value);

const read = (): ReasoningRule => {
  try {
    const stored = localStorage.getItem(REASONING_RULE_STORAGE_KEY);
    return isRule(stored) ? stored : DEFAULT_RULE;
  } catch {
    // Storage blocked: the default applies, every page view.
    return DEFAULT_RULE;
  }
};

// One rule for every transcript on the page, so the chat and task dialogs
// can't disagree. ponytail: a module-level store rather than a context — no
// provider to mount, and nothing else needs to own it.
let current = read();
const listeners = new Set<() => void>();

/** Changes the rule everywhere, and remembers it for next time. */
export const setReasoningRule = (rule: ReasoningRule): void => {
  current = rule;
  try {
    localStorage.setItem(REASONING_RULE_STORAGE_KEY, rule);
  } catch {
    // Still applies for this page view.
  }
  for (const listener of listeners) listener();
};

/** Re-reads storage. Tests only: the module keeps its value between them. */
export const resetReasoningRule = (): void => {
  current = read();
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** The current rule, re-rendering when it changes. */
export const useReasoningRule = (): ReasoningRule =>
  useSyncExternalStore(subscribe, () => current);
