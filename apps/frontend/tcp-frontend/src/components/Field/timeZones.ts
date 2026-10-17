/**
 * Every IANA zone this browser knows, for suggestions and for checking a typed
 * one. `UTC` is added as the server's validator adds it: `supportedValuesOf`
 * leaves it out, yet it is what a browser set to UTC reports as its own zone.
 */
export const TIME_ZONES: readonly string[] = [
  ...Intl.supportedValuesOf('timeZone'),
  'UTC',
];

/** The viewer's own zone, as a default for a new company. */
export const browserTimeZone = (): string =>
  Intl.DateTimeFormat().resolvedOptions().timeZone;

/** True for an empty value (no zone) or a zone from {@link TIME_ZONES}. */
export const isKnownTimeZone = (value: string): boolean =>
  value === '' || TIME_ZONES.includes(value);
