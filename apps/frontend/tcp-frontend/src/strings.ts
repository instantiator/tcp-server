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
  // 003.03 wrote these two as placeholders for 007.01 to finalise. They were
  // right, and are kept — the pair reads correctly at one and at many, and
  // "added"/"completed" say what happened rather than what the list now holds.
  'announce.tasksAdded': 'Tasks: {count} added',
  'announce.tasksCompleted': '{count} completed',
  'announce.agentsStarted': 'Agents: {count} started',
  'announce.agentsFinished': '{count} finished',
  'announce.consultationsOpened': 'Consultations: {count} opened',
  'announce.consultationsClosed': '{count} closed',
  // Its own channel, spoken immediately: an agent waiting on a person is a
  // request to act, not a change to the furniture (ADR-027).
  'announce.enquiryNew': 'New enquiries: {count}',
  // `{count}` is reserved: the announcer supplies it as the number of times a
  // change repeated, and overwrites any value a caller passes under that name.
  // An announcement that needs a domain number must call it something else.
  'announce.companiesLoaded': 'Companies loaded',
  'announce.companyLoaded': '{name} loaded',

  'state.loading': 'Loading {label}…',
  'state.error.label': 'Error',
  'state.error.announcement': 'Error: {message}',
  'state.error.retry': 'Try again',

  'notification.label': 'Notification',
  'notification.announcement': '{message}',
  'notification.dismiss': 'Dismiss',

  'page.companies.title': 'Companies',
  'page.company.title': 'Company',

  // The companies overview. `companies.loading` is a label rather than a
  // sentence: `LoadingState` renders it through `state.loading`, as "Loading
  // your companies…".
  'companies.loading': 'your companies',
  'companies.error.failed': 'Your companies could not be loaded.',
  'companies.error.forbidden': 'You are not permitted to list companies.',
  'companies.empty.heading': 'You are not a member of any company',
  'companies.empty.body':
    'Companies are created and managed with tcp-cli, the command-line tool — the web client cannot create one yet. Ask whoever runs this system to add you to a company.',
  'companies.stat.activeAgents': 'Active agents',
  'companies.stat.activeTasks': 'Active tasks',
  'companies.stat.openEnquiries': 'Open enquiries',

  // The company view shell. `company.loading` is a label, as above.
  'company.loading': 'this company',
  'company.error.failed': 'This company could not be loaded.',
  'company.unavailable.heading': 'This company is not available',
  'company.unavailable.body':
    'You may not be a member of it, or it may no longer exist.',
  'company.unavailable.back': 'Go to your companies',
  'company.stream.failed':
    'Live updates have stopped. Reload the page to reconnect.',
  'company.tabs.label': 'Company views',
  'company.tab.activity': 'Live activity',

  // The live activity view. `activity.loading` is a label, as above — every
  // list renders it through `state.loading`, as "Loading this list…".
  'activity.loading': 'this list',
  'activity.error.failed': 'This list could not be loaded.',
  // Rendered text rather than an announcement, which is the only reason it may
  // use `{count}` — the announcer's reservation applies to `announce.*` alone.
  'activity.count': '{count} shown',

  'activity.agents.heading': 'Active agents',
  'activity.agents.empty.heading': 'No agents are working',
  'activity.agents.empty.body':
    'Agents appear here while they are running. Start a task and the agents working it will show up.',

  'activity.tasks.heading': 'Tasks',
  'activity.tasks.empty.heading': 'No tasks to show',
  'activity.tasks.empty.body':
    'No task has one of the selected statuses. Change the filter to see others.',

  'activity.consultations.heading': 'Consultations',
  'activity.consultations.empty.heading': 'No consultations are open',
  'activity.consultations.empty.body':
    'Consultations appear here when one agent asks another for help.',
  // ADR-023: the list is consultee assignments, so a consultation that has been
  // requested but not yet picked up is genuinely absent. Say so on the page —
  // a list that quietly under-reports is worse than one that admits its limit.
  'activity.consultations.partial':
    'A consultation appears once an agent picks it up, so one just requested may not be listed yet.',

  'activity.enquiries.heading': 'Enquiries',
  'activity.enquiries.empty.heading': 'No agents are waiting on you',
  'activity.enquiries.empty.body':
    'When an agent needs an answer from a person, its question appears here.',

  'activity.filter.label': 'Task statuses',
  'activity.status.ready': 'Ready',
  'activity.status.planning': 'Planning',
  'activity.status.in-progress': 'In progress',
  'activity.status.finalising': 'Finalising',
  'activity.status.succeeded': 'Succeeded',
  'activity.status.failed': 'Failed',
  'activity.status.cancelled': 'Cancelled',
  // Agent and assignment statuses share this block: the words are the user's,
  // not the schema's, and several are common to both.
  'activity.status.idle': 'Idle',
  'activity.status.running': 'Running',
  'activity.status.paused': 'Paused',
  'activity.status.completed': 'Completed',
  'activity.status.in-qa': 'In QA',
  'activity.status.unknown': 'Unknown',
  // Agent and consultation rows carry a role whose name may not have loaded.
  'activity.role.unknown': 'Unknown role',
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

  // Session recovery on page load and expiry warnings. `session.recovering` is a
  // label rather than a sentence: `LoadingState` renders it through `state.loading`,
  // as "Loading your session…".
  'session.recovering': 'your session',
  'session.recovery.failed':
    'We could not reach the sign-in service. Check your connection and try again.',
  'session.expiry.label': 'Session expiry',
  'session.expiring': 'Your session is about to expire.',
  'session.staySignedIn': 'Stay signed in',
  'session.expiring.announcement':
    'Your session is about to expire. Choose "Stay signed in" to continue.',
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
