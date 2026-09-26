import { t, type StringKey } from '../../../../strings';

// Every `AssignmentDTO['mode']` value, mapped to its string key. A `Record`
// lookup rather than a template-literal key, for the same reason
// `api/statuses.ts`'s `STATUS_KEYS` is one: the latter would type as
// `string`, not `StringKey`, and need a cast to reach `t`.
const MODE_KEYS: Record<string, StringKey> = {
  plan: 'visualisation.mode.plan',
  implement: 'visualisation.mode.implement',
  qa: 'visualisation.mode.qa',
  chat: 'visualisation.mode.chat',
  consultee: 'visualisation.mode.consultee',
  finalise: 'visualisation.mode.finalise',
};

/**
 * The user's word for an assignment's mode, falling back rather than
 * printing a schema value — the same shape as `statusLabel` in
 * `api/statuses.ts`, for the same reason: a shared component must not reach
 * into a page's own directory for this.
 */
export const modeLabel = (mode: string): string => {
  const key = MODE_KEYS[mode];
  return key === undefined ? t('visualisation.mode.unknown') : t(key);
};
