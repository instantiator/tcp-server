import { t } from '../../strings';

/**
 * How much of a long text shows before it is clipped.
 *
 * A judgement call, not a measurement: roughly two lines at the width the
 * activity rows render at, which is enough to tell one prompt from another
 * without letting a several-paragraph brief push everything else off the
 * screen. Re-tune it against the real layout rather than deriving it.
 */
export const EXCERPT_LENGTH = 160;

/** The opening of a text, cut back to a word boundary where there is one. */
export const excerptOf = (text: string): string => {
  const clipped = text.slice(0, EXCERPT_LENGTH);
  const lastSpace = clipped.lastIndexOf(' ');
  // Only a boundary at least halfway along is worth backing off to: a text
  // whose opening holds no space at all still has to be clipped somewhere.
  return lastSpace > EXCERPT_LENGTH / 2 ? clipped.slice(0, lastSpace) : clipped;
};

/** The text itself when it is short, or its excerpt marked as unfinished. For places with no room for a control, like a tooltip. */
export const shortened = (text: string): string =>
  text.length <= EXCERPT_LENGTH
    ? text
    : t('expandableText.truncated', { excerpt: excerptOf(text) });
