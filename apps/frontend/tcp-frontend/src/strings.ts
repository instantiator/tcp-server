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

  'shell.skipToContent': 'Skip to content',

  'header.account.label': 'Account',
  'header.account.profile': 'My profile',
  'header.account.memberships': 'My company memberships',
  'header.account.signOut': 'Sign out',

  'breadcrumbs.label': 'Breadcrumb',

  'page.companies.title': 'Companies',
  'page.company.title': 'Company',
  'page.notFound.title': 'Page not found',
  'page.notFound.body':
    'That address does not match anything in this application. It may have been mistyped, or the thing it pointed at may no longer exist.',
  'page.notFound.home': 'Go to the landing page',
} as const;

/** Every key `t` accepts. A typo is a type error, not a blank screen. */
export type StringKey = keyof typeof strings;

/** Resolves a user-facing string. */
export const t = (key: StringKey): string => strings[key];
