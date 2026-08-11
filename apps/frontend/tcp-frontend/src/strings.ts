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

  'dialog.close': 'Close',
  'dialog.minimise': 'Minimise',
  // Names the bar, not the buttons in it. Each button is labelled by the
  // dialog it restores, so its visible text and its accessible name match
  // (WCAG 2.5.3); what the bar is for is said once, here.
  'dock.label': 'Minimised dialogs',

  // The transcript. `transcript.loading` is a label rather than a sentence:
  // `LoadingState` renders it through `state.loading`, as "Loading this
  // conversation…".
  'transcript.label': 'Conversation with {role}',
  'transcript.loading': 'this conversation',
  'transcript.blank': '(blank)',
  'transcript.empty.heading': 'Nothing to show yet',
  'transcript.empty.body': 'This agent has not done anything yet.',
  'transcript.error.refused': 'You are not permitted to watch this agent.',
  'transcript.error.atCapacity':
    'Too many live views are open. Close one and try again.',
  'transcript.error.failed': 'This conversation could not be loaded.',
  // `announce.responseBody` is unused while `ANNOUNCE_RESPONSE_BODY` is false;
  // ADR-027 leaves the choice to 009.02's manual screen reader pass, and both
  // wordings have to exist for that pass to be a one-line change.
  'transcript.announce.response': 'Response from {role} received',
  'transcript.announce.responseBody': '{role} replied: {body}',
  // The label React Aria's audit-event rows carry after the time. Rendered as
  // written by the shared renderers, so it is not a translatable string.
  'transcript.entry.label': '{time}, {label}',

  // The chat dialog (008.02). Its panels reuse the transcript above; these
  // keys are what surrounds it: the dialog's own heading, each panel's
  // heading and completion control, and the message form.
  'chat.dialog.heading': 'Chats',
  'chat.conversation.label': 'Chat with {role}',
  'chat.conversation.labelWithReference': 'Chat with {role} ({reference})',
  'chat.complete': 'Complete the chat with {role}',
  'chat.message.label': 'Message {role}',
  'chat.send': 'Send',
  'chat.waiting': 'Waiting for {role} to reply…',
  // One wording for all three terminal statuses. A chat that failed mid-turn
  // has already said so in its own transcript, and a second, differently
  // worded sentence beside a form that no longer exists would explain the
  // failure worse than the transcript does.
  'chat.done': 'This chat is complete.',
  'chat.send.failed':
    'That message could not be sent. Your text is still here — try again.',
  'chat.complete.failed': 'This chat could not be completed. Try again.',
  'chat.dock.label': '{role} — {status}',

  // The task dialog (008.03): its own heading, the task's details, one
  // collapsible panel per assignment, and the confirmed cancel control.
  'task.dialog.heading': 'Task {shortcode}',
  'task.dialog.heading.pending': 'Task',
  'task.loading': 'this task',
  'task.error': 'This task could not be loaded. Try again.',
  'task.details.label': 'Task details',
  'task.details.request': 'Request',
  'task.details.status': 'Status',
  'task.details.failureReason': 'Why it failed',
  'task.assignments.heading': 'Work on this task',
  'task.assignments.empty.heading': 'No work has started yet',
  'task.assignments.empty.body':
    'Roles appear here once the task has been planned.',
  'task.assignment.label': '{role} — {status}',
  'task.assignment.expand': 'Show what {role} has done',
  'task.assignment.collapse': 'Hide what {role} has done',
  'task.assignment.noAgent.heading': 'Not started',
  'task.assignment.noAgent.body': 'No agent has picked this up yet.',
  'task.cancel': 'Cancel this task',
  'task.cancel.confirm.heading': 'Cancel this task?',
  'task.cancel.confirm.body':
    'This stops the task and every agent working on it. A cancelled task cannot be restarted.',
  'task.cancel.confirm.accept': 'Cancel the task',
  'task.cancel.confirm.reject': 'Keep the task running',
  'task.cancel.failed': 'This task could not be cancelled. Try again.',
  'task.announce.loaded': 'Task {shortcode} loaded',
  'task.announce.status': 'Task: {status}',
  'task.announce.assignment': '{role}: {status}',

  // 008.04 — the user response dialog, where an agent's question is answered.
  // `enquiry.loading` is a label rather than a sentence, as above.
  'enquiry.dialog.heading': 'Question from {role}',
  'enquiry.dialog.heading.pending': 'Question',
  'enquiry.loading': 'this question',
  'enquiry.error': 'This question could not be loaded. Try again.',
  'enquiry.question.label': 'The question',
  'enquiry.context.label': 'Context',
  'enquiry.messages.label': 'Conversation',
  'enquiry.messages.empty.heading': 'Nothing said yet',
  'enquiry.messages.empty.body': 'The question above is all there is so far.',
  'enquiry.message.author.user': 'You',
  'enquiry.message.author.agent': '{role}',
  'enquiry.reply.label': 'Your answer',
  'enquiry.reply.required': 'Type an answer before sending.',
  'enquiry.reply.send': 'Send answer',
  // "Sent", not "resumed". The reply route returns before the agent has picked
  // up again, so anything stronger would claim more than is known.
  'enquiry.reply.sent': 'Your answer has been sent.',
  'enquiry.reply.failed': 'Your answer could not be sent. Try again.',
  'enquiry.reply.alreadyAnswered':
    'This question has already been answered somewhere else, so your answer was not sent.',
  'enquiry.reply.gone': 'This question no longer exists.',
  'activity.enquiries.open': 'Answer the question from {role}',
  'activity.enquiries.notification': '{role} has asked a question.',
  'activity.enquiries.notification.link': 'Go to the enquiries list',

  // 008.05 — the task creation dialog. Neither button says a bare "Cancel":
  // in a task dialog that word already means cancelling the task itself.
  'task.create.heading': 'New task',
  'task.create.request.label': 'What needs doing',
  'task.create.request.description':
    'Describe the work in your own words. A planning role turns this into a plan.',
  'task.create.request.required': 'Describe the work before creating the task.',
  'task.create.plannerRole.label': 'Planning role',
  'task.create.plannerRole.any': 'Let the company decide',
  'task.create.expected.label': 'Expected output {position}',
  'task.create.expected.description':
    'A file you expect the task to produce, if you know it.',
  'task.create.expected.add': 'Add an expected output',
  'task.create.expected.remove': 'Remove expected output {position}',
  'task.create.expected.required': 'Name the file, or remove this row.',
  'task.create.materials.label': 'Files to attach',
  'task.create.materials.selected': 'Files chosen',
  'task.create.materials.remove': 'Remove {filename}',
  'task.create.materials.failed':
    'The task was created, but these files did not attach: {filenames}. It has not been started.',
  'task.create.start.label': 'Start this task now',
  'task.create.submit': 'Create task',
  'task.create.submit.pending': 'Creating…',
  'task.create.close': 'Close',
  'task.create.discard': 'Discard this task',
  'task.create.failed': 'This task could not be created. Try again.',
  'task.create.rejected':
    'The server refused this task. Check the form and try again.',
  'task.create.warnings.label': 'Worth knowing',
  'task.create.announce.started': 'Task {shortcode} created and started',
  'task.create.announce.created':
    'Task {shortcode} created. It has not started yet.',

  // 008.06 — the two read-only dialogs on the account menu. Both are read-only
  // by scope decision (ADR-020), not by oversight.
  'profile.heading': 'My profile',
  'profile.name.label': 'Name',
  'profile.email.label': 'Email',
  'profile.subject.label': 'Account identifier',
  'profile.claim.missing': 'Not provided by your sign-in provider',
  // Names the setting, because an otherwise-empty dialog has a configuration
  // cause and a fix — it is not a fault in the dialog.
  'profile.claims.none':
    'Your sign-in provider did not send your name or email. An administrator can set OIDC_LOAD_USER_INFO to true to fetch them.',
  'profile.readOnly': 'Your details are managed by your sign-in provider.',
  'memberships.heading': 'My company memberships',
  // Authoritative, not informational (002.05): membership is the access
  // control, and a company absent from this list refuses the user with a 403.
  'memberships.intro': 'The companies you have access to.',
  'memberships.loading': 'your companies',
  'memberships.error': 'Your companies could not be loaded. Try again.',
  'memberships.empty.heading': 'You cannot reach any company yet',
  'memberships.empty.body':
    'Ask an administrator to add you to a company. Until then there is nothing here to open.',

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
  'announce.chatsStarted': 'Chats: {count} started',
  'announce.chatsEnded': '{count} ended',
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
  // A long prompt is shown as an excerpt until it is asked for. The marker is a
  // string rather than a character appended in JSX, because it is text the user
  // reads (ADR-021), and because a translation may not mark truncation the same
  // way. The pair below name the role, so the several expanders a page can hold
  // at once are told apart (WCAG 2.4.6) — the same shape as `activity.chats.open`.
  'activity.agents.prompt.truncated': '{excerpt}…',
  'activity.agents.prompt.expand': 'Show the full prompt for {role}',
  'activity.agents.prompt.collapse': 'Show less of the prompt for {role}',

  'activity.tasks.heading': 'Tasks',
  'activity.tasks.empty.heading': 'No tasks to show',
  'activity.tasks.empty.body':
    'No task has one of the selected statuses. Change the filter to see others.',
  'activity.tasks.open': 'Open task {shortcode}',

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

  'activity.chats.heading': 'Chats',
  'activity.chats.empty.heading': 'No chats',
  'activity.chats.empty.body': 'Start a chat with a role to talk to its agent.',
  'activity.chats.open': 'Open the chat with {role}',
  'activity.chats.filter.status.label': 'Chat status',
  'activity.chats.filter.status.open': 'Open',
  'activity.chats.filter.status.completed': 'Completed',
  'activity.chats.filter.role.label': 'Roles',

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
