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
  'landing.signIn.failed':
    'Sign-in could not be started. The identity provider could not be reached.',
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

  // Announcements. Every wording here is deliberately count-agnostic —
  // 'Tasks: {count} added', never '{count} tasks added' — because `t` has no
  // plural rules and reads the same for one as for many.
  'announce.separator': ', ',
  'announce.routeChange': '{title}',
  'announce.tasksAdded': 'Tasks: {count} added',
  'announce.tasksCompleted': '{count} completed',

  'state.loading': 'Loading {label}…',
  'state.error.label': 'Error',
  'state.error.announcement': 'Error: {message}',
  'state.error.retry': 'Try again',

  'notification.label': 'Notification',
  'notification.announcement': '{message}',
  'notification.dismiss': 'Dismiss',

  'page.companies.title': 'Companies',
  'page.company.title': 'Company',
  'page.notFound.title': 'Page not found',
  'page.notFound.body':
    'That address does not match anything in this application. It may have been mistyped, or the thing it pointed at may no longer exist.',
  'page.notFound.home': 'Go to the landing page',

  // The callback route. `callback.loading` is a label rather than a sentence:
  // `LoadingState` renders it through `state.loading`, as "Loading sign-in…".
  'page.callback.title': 'Signing in',
  'callback.loading': 'sign-in',
  'callback.error.cancelled':
    'Sign-in was cancelled. You have not been signed in.',
  'callback.error.failed':
    'Sign-in could not be completed. Try signing in again.',
  'callback.error.direct':
    'This page is part of signing in and cannot be opened on its own.',
} as const;

/** Every key `t` accepts. A typo is a type error, not a blank screen. */
export type StringKey = keyof typeof strings;

/** Values interpolated into a string's `{placeholder}` slots. */
export type StringParams = Readonly<Record<string, string | number>>;

/**
 * Resolves a user-facing string, filling `{placeholder}` slots from `params`.
 *
 * This is the whole of the interpolation this application has: no
 * pluralisation, no number or date formatting, no nesting. Announcements need
 * it — "Tasks: 2 added" cannot be assembled from a key alone without inlining
 * the number beside the words in JSX, which ADR-021 forbids — and the phase 03
 * i18n work still replaces this module rather than every call site, because
 * `t(key, params)` is the signature every real library also offers.
 *
 * An unmatched placeholder is left in place rather than blanked, so a missing
 * value shows up in the output instead of silently producing "Tasks: added".
 */
export const t = (key: StringKey, params?: StringParams): string =>
  params === undefined
    ? strings[key]
    : strings[key].replace(/\{(\w+)\}/g, (placeholder, name: string) =>
        name in params ? String(params[name]) : placeholder,
      );
