/**
 * The header tcp-server puts soft data-quality warnings in.
 *
 * Not imported from the server: nothing in the browser bundle may reach into
 * `apps/backend`, and an eslint rule enforces that. The name is duplicated
 * from `validation-warnings.ts` rather than shared, the same way `tcp-cli`
 * has its own copy.
 */
const WARNINGS_HEADER = 'X-Tcp-Warnings';

/**
 * Soft warnings carried alongside a successful response, or an empty list.
 *
 * These do not fail the request — they report something worth knowing about
 * what was just created. The value is a JSON array of percent-encoded
 * strings: the server encodes each entry because Node rejects non-Latin1
 * characters in a header outright, and a warning can embed an arbitrary
 * third-party error message.
 *
 * **Nothing here may throw.** A malformed header would otherwise turn a
 * request the server accepted into a failure the user sees, which is a worse
 * outcome than losing a warning. A single undecodable entry falls back to its
 * raw form rather than dropping the whole batch, matching `reportWarnings` in
 * `apps/backend/apps/tcp-cli/src/lib/core/api.ts`.
 */
export const readWarnings = (response: Response): readonly string[] => {
  const raw = response.headers.get(WARNINGS_HEADER);
  if (raw === null || raw === '') return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  return parsed
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => {
      try {
        return decodeURIComponent(entry);
      } catch {
        return entry;
      }
    });
};
