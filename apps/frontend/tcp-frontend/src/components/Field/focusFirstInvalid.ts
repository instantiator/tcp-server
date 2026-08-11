import type { RefObject } from 'react';

/**
 * Moves focus to the first field the caller has marked invalid.
 *
 * A failed submit that leaves focus where it was makes a keyboard user hunt
 * for the problem, and a screen reader user may not learn there was one at all
 * (ADR-026).
 *
 * Its own module rather than sitting beside {@link TextField}, because
 * `react-refresh/only-export-components` is an error here — the same reason
 * `ChatDialog`'s `useChat.ts` is separate from its provider.
 */
export const focusFirstInvalid = (
  fields: readonly {
    readonly error?: string;
    readonly ref: RefObject<HTMLElement | null>;
  }[],
): void => {
  fields.find((field) => field.error !== undefined)?.ref.current?.focus();
};
