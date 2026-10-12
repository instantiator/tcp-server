import type { RecordData } from './records.types';

/** The longest entry the do-not-store list takes. */
export const DO_NOT_STORE_MAX_LENGTH = 200;

/** A letter or digit in any script: what a whole-word match must not touch. */
const WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * The form entries and record text are compared in: lower case, accents
 * dropped (so "José" and "Jose" are the same person), with each run of
 * whitespace as one space, trimmed.
 */
export function normaliseDoNotStore(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The fields of `data` whose text contains a do-not-store entry as a whole
 * phrase: "Ann Lee" matches "Deliver to ann lee, 3 High St" but "Ann" doesn't
 * match "Annual". `entries` must already be normalised.
 */
// ponytail: text fields only; a phone number stored as a number isn't checked.
export function doNotStoreFields(
  data: RecordData,
  entries: readonly string[],
): string[] {
  if (entries.length === 0) return [];
  return Object.entries(data)
    .filter(([, value]) => typeof value === 'string')
    .filter(([, value]) => {
      const text = normaliseDoNotStore(value as string);
      return entries.some((entry) => containsPhrase(text, entry));
    })
    .map(([field]) => field);
}

/** Whether `phrase` appears in `text` with no letter or digit either side. */
function containsPhrase(text: string, phrase: string): boolean {
  for (
    let i = text.indexOf(phrase);
    i !== -1;
    i = text.indexOf(phrase, i + 1)
  ) {
    if (!isWordChar(text[i - 1]) && !isWordChar(text[i + phrase.length])) {
      return true;
    }
  }
  return false;
}

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && WORD_CHAR.test(char);
}
