/**
 * The single lookup every user-facing string resolves through. **No string is
 * inlined in JSX** (ADR-021).
 *
 * There is no i18n library and there are no locale files yet. This module
 * exists so that the phase 03 translation work replaces one module rather
 * than rewriting every component: `t('key')` is the call signature that has
 * to survive, so keep call sites to `t(…)` and never import `strings`
 * directly.
 */
const strings = {
  'app.title': 'TCP',

  'landing.intro':
    'TCP manages one or more companies of AI agents that collaborate to complete tasks. Sign in to watch a company work, and to take part.',
  'landing.getStarted.heading': 'Get started',
  'landing.signIn': 'Sign in',
  'landing.appearance.heading': 'Appearance',

  'theme.palette.label': 'Theme',
  'theme.palette.default': 'Default',
  'theme.palette.highContrast': 'High contrast',
  'theme.mode.label': 'Colour mode',
  'theme.mode.light': 'Light',
  'theme.mode.dark': 'Dark',
} as const;

/** Every key `t` accepts. A typo is a type error, not a blank screen. */
export type StringKey = keyof typeof strings;

/** Resolves a user-facing string. */
export const t = (key: StringKey): string => strings[key];
