/** Every IANA zone this browser knows, for suggestions and for checking a typed one. */
export const TIME_ZONES: readonly string[] = Intl.supportedValuesOf('timeZone');

/** The viewer's own zone, as a default for a new company. */
export const browserTimeZone = (): string =>
  Intl.DateTimeFormat().resolvedOptions().timeZone;

/** True for an empty value (no zone) or a zone from {@link TIME_ZONES}. */
export const isKnownTimeZone = (value: string): boolean =>
  value === '' || TIME_ZONES.includes(value);
