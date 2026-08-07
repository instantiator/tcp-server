import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';

// Built once at module scope — Intl.supportedValuesOf('timeZone') enumerates
// the runtime's full IANA database, and that set doesn't change at runtime.
// 'UTC' is added explicitly: it's a distinguished value Intl.DateTimeFormat
// accepts directly, but supportedValuesOf omits it because it isn't an IANA
// zone name (the IANA equivalent is 'Etc/UTC', which is already included).
const IANA_TIME_ZONES = new Set([...Intl.supportedValuesOf('timeZone'), 'UTC']);

// Case-insensitive lookup for normalizeIanaTimeZone, built from the same set.
const CANONICAL_BY_LOWERCASE = new Map(
  [...IANA_TIME_ZONES].map((zone) => [zone.toLowerCase(), zone]),
);

/**
 * Rewrites a case-insensitive IANA match to its canonical form (e.g.
 * `europe/london` → `Europe/London`), leaving anything else — including
 * non-strings — untouched so {@link IsIanaTimeZone} still reports the
 * original, unrecognised value. Intended as a `class-transformer` `@Transform`
 * applied before `@IsIanaTimeZone()`, so a caller's case typo doesn't need to
 * be exact.
 */
export function normalizeIanaTimeZone(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return CANONICAL_BY_LOWERCASE.get(value.toLowerCase()) ?? value;
}

/**
 * Rejects a value that isn't an exact, case-sensitive IANA time zone name
 * (e.g. `Europe/London`). Pair with {@link normalizeIanaTimeZone} to accept
 * case-insensitive input. Consumers (`prompt-vars.ts`, `read-query.action.ts`)
 * already fall back safely on an invalid zone, so this exists to fail fast at
 * write time instead of silently at render time.
 */
export function IsIanaTimeZone(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return (object: object, propertyName: string | symbol): void => {
    registerDecorator({
      name: 'isIanaTimeZone',
      target: object.constructor,
      propertyName: propertyName as string,
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          return typeof value === 'string' && IANA_TIME_ZONES.has(value);
        },
        defaultMessage(args: ValidationArguments): string {
          return `${args.property} must be a valid IANA time zone name (e.g. "Europe/London"), got "${String(args.value)}"`;
        },
      },
    });
  };
}
