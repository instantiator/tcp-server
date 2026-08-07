import { UUID } from 'crypto';

/** Guard to confirm that the value is defined and not null */
export const defined = <T>(value: T | undefined | null): value is T => {
  return value !== undefined && value !== null;
};

/** Guard to confirm that the value is a valid UUID */
export const isUUID = (value: string): value is UUID => {
  const uuidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(value);
};
