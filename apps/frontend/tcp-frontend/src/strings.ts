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
  /** The header's title inside a company. */
  'app.titleWithCompany': 'TCP: {company}',

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
  'header.system.label': 'System',
  'header.system.health': 'System health',
  'header.system.shutdown': 'Shut down or restart…',

  'breadcrumbs.label': 'Breadcrumb',

  'dialog.close': 'Close',
  'dialog.minimise': 'Minimise',
  'confirm.yes': 'Yes',
  'confirm.no': 'No',
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
  // ADR-027 leaves the choice to 001.02 (phase 06)'s manual screen reader pass, and both
  // wordings have to exist for that pass to be a one-line change.
  'transcript.announce.response': 'Response from {role} received',
  'transcript.announce.responseBody': '{role} replied: {body}',
  // The label React Aria's audit-event rows carry after the time. Rendered as
  // written by the shared renderers, so it is not a translatable string.
  'transcript.entry.label': '{time}, {label}',
  // 000.06 — reasoning accordions and following the latest entry.
  'transcript.reasoning.label': 'Show or hide reasoning',
  'transcript.reasoning.all': 'Show all reasoning',
  'transcript.reasoning.none': 'Hide all reasoning',
  'transcript.reasoning.latest': 'Show latest reasoning only',
  'transcript.follow': 'Follow latest',
  'transcript.tool.requestField': 'Request field',
  'transcript.tool.responseField': 'Response field',
  'transcript.tool.value': 'Value',
  'transcript.tool.name': 'Tool name',
  'transcript.tool.status': 'Status',
  'transcript.tool.content': 'Content',
  'transcript.tool.fullJson': 'Full JSON',

  // The chat dialog (008.02). Its panels reuse the transcript above; these
  // keys are what surrounds it: the dialog's own heading, each panel's
  // heading and completion control, and the message form.
  'chat.dialog.heading': 'Chats',
  'chat.conversation.label': 'Chat with {role}',
  'chat.conversation.labelWithReference': 'Chat with {role} ({reference})',
  'chat.conversation.listening': 'Listening in: {role}',
  'chat.conversation.listeningWithReference':
    'Listening in: {role} ({reference})',
  // Archiving a role chat completes it: the prompt's "ends a conversation".
  'chat.complete': 'Archive the chat with {role}',
  // 000.06 — the list of views, and what a view's controls do.
  'chat.list.label': 'Chats list',
  'chat.search.label': 'Search chats',
  'chat.search.announce': 'Chats matching: {count}',
  'chat.list.group.chats': 'Chats',
  'chat.list.group.running': 'Listening in, running',
  'chat.list.group.finished': 'Listening in, finished',
  'chat.list.kind.chat': 'Chat',
  'chat.list.kind.listening': 'Listening in',
  'chat.list.state.open': 'Open',
  'chat.list.state.completed': 'Completed',
  'chat.list.state.running': 'Running',
  'chat.list.state.finished': 'Finished',
  'chat.list.started': 'started {time}',
  'chat.list.showArchived': 'Show archived',
  'chat.list.empty': 'No chats yet.',
  'chat.list.noMatches': 'No chats match.',
  'chat.view.empty.heading': 'No chat selected',
  'chat.view.empty.body': 'Choose a chat, or start one with +.',
  'chat.archive.listening': 'Archive listening in on {role}',
  'chat.delete': 'Delete the chat with {role}',
  'chat.delete.failed': 'The chat could not be deleted.',
  'chat.delete.confirm.heading': 'Delete this chat?',
  'chat.delete.confirm.body':
    'The chat with {role} and its transcript will be deleted. This can’t be undone.',
  'chat.delete.confirm.accept': 'Delete the chat',
  'chat.delete.confirm.reject': 'Keep the chat',
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
  'task.details.waiting': "Why it's waiting",
  'task.details.pausing': 'Pausing — agents stop after their current step',
  'task.assignments.heading': 'Work on this task',
  'task.assignments.empty.heading': 'No work has started yet',
  'task.assignments.empty.body':
    'Roles appear here once the task has been planned.',
  'task.assignment.label': '{role} — {status}',
  'task.assignment.expand': 'Show what {role} has done',
  'task.assignment.failureReason': 'Why it failed: {reason}',
  'task.assignment.collapse': 'Hide what {role} has done',
  'task.assignment.noAgent.heading': 'Not started',
  'task.assignment.noAgent.body': 'No agent has picked this up yet.',
  'task.cancel': 'Cancel',
  'task.cancel.confirm.heading': 'Cancel this task?',
  'task.cancel.confirm.body':
    'This stops the task and every agent working on it. A cancelled task cannot be restarted.',
  'task.cancel.confirm.accept': 'Cancel the task',
  'task.cancel.confirm.reject': 'Keep the task running',
  'task.start': 'Start',
  'task.pause': 'Pause this task',
  'task.resume': 'Resume this task',
  'task.edit': 'Edit',
  'task.start.icon': 'Start task {shortcode}',
  'task.edit.icon': 'Edit task {shortcode}',
  'task.pause.icon': 'Pause task {shortcode}',
  'task.resume.icon': 'Resume task {shortcode}',
  'task.cancel.icon': 'Cancel task {shortcode}',
  'task.edit.heading': 'Edit task {shortcode}',
  'task.edit.submit': 'Save changes',
  'task.edit.submit.pending': 'Saving…',
  'task.edit.discard': 'Discard changes',
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

  // 003.01 — the "Add new" menu: create a task, or start a chat with a role.
  'addNew.trigger': 'Add new',
  'addNew.createTask': 'Create a new task',
  'addNew.newChat': 'New chat',
  'addNew.chatWithRole': 'Chat with a role',
  'addNew.listenIn': 'Listen in on an assignment',
  'addNew.listenIn.option': '{role} ({reference})',
  'addNew.noAssignments': 'Nothing is running to listen in on',
  'addNew.starting': 'Starting chat with {role}…',
  'addNew.noRoles': 'This company has no roles yet',
  'addNew.loadingRoles': 'Loading roles…',
  'addNew.error': 'Could not start a chat with {role}. Try again.',

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

  'systemHealth.heading': 'System health',
  'systemHealth.loading': 'system health',
  'systemHealth.error': 'The system health could not be loaded. Try again.',
  'systemHealth.allUp': 'All services are up',
  // Counted phrase, picked by `tCount`.
  'systemHealth.down.one': '{count} service is down',
  'systemHealth.down.other': '{count} services are down',
  'systemHealth.service': '{name}: {status}',
  'systemHealth.status.up': 'Up',
  'systemHealth.status.down': 'Down',
  'systemHealth.status.not_configured': 'Not configured',
  'systemHealth.refresh': 'Refresh',
  'systemHealth.fullReport': 'Full report',
  'shutdown.heading': 'Shut down or restart',
  'shutdown.loading': 'shutdown status',
  'shutdown.error': 'The shutdown status could not be loaded. Try again.',
  'shutdown.explain':
    'A graceful shutdown lets every agent finish its current step, then pauses it. Paused tasks wait until someone resumes them.',
  'shutdown.explainRestart':
    'Restart does the same, then restarts the services. Paused work resumes.',
  'shutdown.restart': 'Restart',
  'shutdown.graceful': 'Shutdown',
  'shutdown.force': 'Force shut down…',
  'shutdown.forceConfirm':
    'This stops agents mid-call and wastes the tokens already spent. Force shut down?',
  'shutdown.forceConfirmed': 'Force shut down',
  'shutdown.back': 'Back',
  'shutdown.draining.one':
    'Shutting down: {count} agent still finishing its current step',
  'shutdown.draining.other':
    'Shutting down: {count} agents still finishing their current step',
  'shutdown.restartDraining.one':
    'Restarting: {count} agent still finishing its current step',
  'shutdown.restartDraining.other':
    'Restarting: {count} agents still finishing their current step',
  'shutdown.quiesced':
    'Every agent is at rest. You can stop the services now, for example with ./scripts/stop-dev.sh. Agents stay paused until resumed.',
  'shutdown.restarting':
    'Restarting the services… This page reconnects by itself.',
  'shutdown.restarted': 'The system restarted. Paused work is carrying on.',
  'shutdown.cancel': 'Cancel shutdown',
  'shutdown.cancelRestart': 'Cancel restart',
  'shutdown.announce.idle': 'The system is taking new work again',
  'shutdown.announce.draining': 'Shutting down: agents are finishing',
  'shutdown.announce.restartDraining': 'Restarting: agents are finishing',
  'shutdown.announce.quiesced': 'Every agent is at rest',
  'shutdown.announce.restarting': 'Restarting the services',
  'shutdown.announce.restarted': 'The system restarted',
  'banner.system.label': 'System status',
  'banner.system.halted':
    "The system has stopped itself: it couldn't record why a task failed. No new work starts. An administrator should check the server log, then cancel the shutdown or restart.",
  'banner.system.draining':
    "The system is shutting down. New work can't start; running agents are finishing their current step.",
  'banner.system.restartDraining':
    'The system is restarting. Running agents are finishing their current step, then everything carries on by itself.',
  'banner.system.quiesced':
    "The system has shut down. Work carries on once it's started again.",
  'banner.system.restarting':
    'The system is restarting. This page reconnects by itself.',
  'banner.system.unreachable':
    "The server can't be reached right now. This page keeps trying.",

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

  // 000.02 — the breadcrumb spend bars (`components/SpendBar`) and the
  // notifications tab/toasts they feed into. `spend.bar.label` names the
  // meter itself; every other `spend.bar.*` key builds its `aria-valuetext`
  // or tooltip lines in `spend-bar-model.ts`.
  'spend.bar.label': 'Spend',
  'spend.bar.uncapped': '{tokens} tokens used since {since}',
  'spend.bar.noUsage': 'no usage yet',
  'spend.bar.capped': '{percent}% of {tokens} tokens per {per}',
  'spend.bar.companyUsage':
    '{tokens} tokens used by this company since {since}',
  'spend.bar.detail.window':
    '{provider}: {percent}% of {tokens} tokens per {per}, since {windowStart}',
  'spend.bar.detail.windowNotStarted':
    '{provider}: {percent}% of {tokens} tokens per {per}, stint not started',
  'spend.bar.detail.nextReset': 'Next reset: {resetsAt}',
  'spend.bar.detail.pausedUntil': 'Paused until {reachedUntil}',
  'spend.bar.detail.provider': '{provider}: {input} in, {output} out',
  'spend.bar.action.pause': 'Running agents pause before their next LLM call',
  'spend.bar.action.finishAgents': 'Running agents finish; no new agents start',
  'spend.bar.action.finishTasks':
    "Running tasks finish; new tasks don't start automatically",

  // The "start now" default (`CreateTaskDialog`): off while a cap holds, with
  // a hint explaining why, associated to the checkbox via `aria-describedby`.
  'task.create.start.cappedHint':
    "A spend cap is reached, so new tasks don't start automatically. You can still start one now.",

  // The Notifications activity tab (`pages/CompanyPage/activity/NotificationsList.tsx`)
  // and the toast that announces a new one (`NewNotificationToasts.tsx`).
  'notifications.heading': 'Notifications',
  'notifications.empty.heading': 'No notifications',
  'notifications.empty.body': 'Spend thresholds and cap notices appear here.',
  'notifications.severity.info': 'Info',
  'notifications.severity.warning': 'Warning',
  'notifications.severity.error': 'Error',
  'notifications.dismiss': 'Dismiss this notification',
  'notifications.resumeCompany': "Resume this company's paused work",
  'notifications.resumeCompany.requested.one':
    'Resume requested for {count} agent',
  'notifications.resumeCompany.requested.other':
    'Resume requested for {count} agents',
  'notifications.resumeCompany.failed':
    'That resume could not be requested. Try again.',
  // Announced through the announcer, not shown on the page — the on-page
  // status is `notifications.resumeCompany.requested.*` above, via `tCount`.
  // Deliberately has no count of its own: `{count}` is the announcer's
  // reserved repeat-count slot (`strings.ts`'s own note on `announce.*`), and
  // a hardcoded plural noun here would read wrong at a count of one.
  'notifications.resumeCompany.announced': 'Resume requested',
  'notifications.openTask': 'Open task',

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
  // Counted phrases, picked by `tCount`: each needs both forms.
  'companies.count.activeAgents.one': '{count} active agent',
  'companies.count.activeAgents.other': '{count} active agents',
  'companies.count.activeTasks.one': '{count} active task',
  'companies.count.activeTasks.other': '{count} active tasks',
  'companies.count.openEnquiries.one': '{count} open enquiry',
  'companies.count.openEnquiries.other': '{count} open enquiries',

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
  'company.tab.visualisation': 'Company view',

  // `components/ExpandableText`: a long text clipped to its opening.
  'expandableText.truncated': '{excerpt}…',

  // The isometric office view.
  'visualisation.stage.label': 'Office view',
  'visualisation.summary':
    'Roles: {roles}. Task rooms: {taskRooms}. Agents: {agents}.',
  'visualisation.keys':
    'Use the arrow keys or W, A, S and D to move the view. Double-click an empty space for full screen.',

  // Stage D (000.01): the toolbar, the details picker, the hover tooltip and
  // the side tray. Wiring these into the canvas is a later step.
  'visualisation.toolbar.label': 'Office view controls',
  'visualisation.pan.left': 'Scroll left',
  'visualisation.pan.right': 'Scroll right',
  'visualisation.pan.up': 'Scroll up',
  'visualisation.pan.down': 'Scroll down',
  'visualisation.fullscreen': 'Full screen',

  'visualisation.picker.label': 'Show details for',
  'visualisation.picker.placeholder': 'Choose a role, task or agent',
  'visualisation.picker.role': 'Role: {name}',
  'visualisation.picker.task': 'Task: {shortcode}',
  'visualisation.picker.agent': 'Agent: {role}',
  'visualisation.picker.agentWithTask': 'Agent: {role} (task {shortcode})',
  'visualisation.picker.archive': 'Archive',
  'visualisation.picker.records': 'Filing cabinet (record tables)',

  'visualisation.tooltip.agent': 'Agent: {role}',
  'visualisation.tooltip.role': 'Role: {role}',
  'visualisation.tooltip.completed': 'Task completed',
  'visualisation.tooltip.task': 'Task {shortcode}: ({step}/{steps})',

  // Canvas labels (`ui/officeLabels.ts`), each kind behind a checkbox.
  'visualisation.labels.label': 'Labels',
  'visualisation.labels.agents': 'Agents',
  'visualisation.labels.roles': 'Roles',
  'visualisation.labels.furniture': 'Furniture',
  'visualisation.labels.rooms': 'Rooms',
  'visualisation.label.agent': 'Agent: {role} ({activity})',
  'visualisation.label.role': 'Role: {role}',
  'visualisation.activity.atDesk': 'at desk',
  'visualisation.activity.working': 'working',
  'visualisation.activity.reviewing': 'reviewing',
  'visualisation.activity.consulting': 'consulting',
  'visualisation.activity.messagingUser': 'messaging a user',
  'visualisation.activity.finished': 'finished',
  'visualisation.activity.waiting': 'waiting to start',

  // Furniture and room titles double as their canvas labels; the
  // descriptions are the tooltip's second line.
  'visualisation.furniture.desk': 'Desk: {role}',
  'visualisation.furniture.deskUnowned': 'Desk',
  'visualisation.furniture.desk.description':
    'An agent of this role works here, and waits here between steps.',
  'visualisation.furniture.whiteboard': 'Whiteboard',
  'visualisation.furniture.sofa': 'Sofa',
  'visualisation.furniture.sofa.description':
    "Part of the rec room, where the company's roles are kept.",
  'visualisation.furniture.pigeonholes': 'Pigeon holes',
  'visualisation.furniture.pigeonholes.description':
    'Agents come here while they wait for an answer from a user.',
  'visualisation.furniture.table': 'Meeting table',
  'visualisation.furniture.table.description':
    'Two agents sit here to consult each other.',
  'visualisation.furniture.officeDoor': 'Office door',
  'visualisation.furniture.officeDoor.description':
    'Agents arrive and leave here.',
  'visualisation.furniture.bookshelf': 'Bookshelf: {count}',
  'visualisation.furniture.filingCabinet': 'Filing cabinet',
  'visualisation.furniture.filingCabinet.description':
    "Holds the company's record tables, such as orders, customers and stock. Select it to check and correct them.",
  'visualisation.furniture.bookshelf.description':
    'Holds the outputs of completed tasks. Select it to see them.',
  'visualisation.room.task': 'Task room: {shortcode}',
  'visualisation.room.task.description':
    'Agents work on task {shortcode} here.',
  'visualisation.room.oneToOne': '1:1 room',
  'visualisation.room.oneToOne.description':
    "Used for a conversation between '{roleA}' and '{roleB}'.",
  'visualisation.room.oneToOne.descriptionUnknown':
    'Used for a conversation between two agents.',
  'visualisation.room.rec': 'Rec room',
  'visualisation.room.rec.description':
    "The company's roles are kept here. New agents collect their role here.",
  'visualisation.room.mail': 'Mail room',
  'visualisation.room.mail.description': "Agents wait here for a user's reply.",
  'visualisation.room.archive': 'Archive',
  'visualisation.room.archive.description':
    "Finished tasks' outputs are filed here.",

  // The side tray (`ui/VisualisationTray.tsx` and its per-kind panels). Not a
  // dialog: nothing here is announced, and the tray's body is read by
  // browsing rather than spoken.
  'visualisation.tray.heading': 'Details',
  'visualisation.tray.loading': 'Loading…',
  'visualisation.tray.gone': 'This is no longer in the office.',
  'visualisation.tray.agentHeading': 'Agent: {role}',
  'visualisation.tray.taskHeading': 'Task {shortcode}',
  'visualisation.tray.roleHeading': 'Role: {name}',
  'visualisation.tray.status': 'Status',
  'visualisation.tray.mode': 'Mode',
  'visualisation.tray.assignmentStatus': 'Assignment status',
  'visualisation.tray.prompt': 'Prompt',
  'visualisation.tray.prompt.expand': 'Show the full prompt',
  'visualisation.tray.prompt.collapse': 'Show less of the prompt',
  'visualisation.tray.description.expand': 'Show the full description',
  'visualisation.tray.description.collapse': 'Show less of the description',
  'visualisation.tray.follow': 'Follow',
  'visualisation.tray.listenIn': 'Listen in to {role}',
  'visualisation.tray.listenInAssignment':
    'Listen in to {role}, assignment {number}',
  'visualisation.tray.assignments': 'Assignments',
  'visualisation.tray.assignmentDescription':
    ', description of assignment {number}',
  'visualisation.tray.chatWithRole': 'Chat with {role}',
  'visualisation.tray.close': 'Close details',
  'visualisation.tray.closeRoom': 'Close room',
  'visualisation.tray.outputs': 'Outputs',
  'visualisation.tray.outputsUnconfigured':
    'The storage browser is not configured, so the outputs link is unavailable.',

  // The archive panel (`ui/ArchiveDetails.tsx`): the bookshelf's tray, a list
  // of completed tasks linking out to Silo. A link's accessible name is its
  // visible `.row` followed by the visually hidden `.linkSuffix`, so what is
  // seen is what is said (WCAG 2.5.3).
  'visualisation.archive.heading': 'Archive',
  'visualisation.archive.empty': 'No completed tasks yet.',
  'visualisation.archive.row': '{shortcode} — {request}',
  'visualisation.archive.linkSuffix': '(outputs in Silo, opens in a new tab)',
  'visualisation.archive.unconfigured':
    'The storage browser is not configured, so these are shown as text only.',

  // Assignment modes, the office's word for each — `modeLabel` in
  // `api/modeLabel.ts`, mirroring
  // `statusLabel` in `api/statuses.ts`.
  'visualisation.mode.plan': 'Planning',
  'visualisation.mode.implement': 'Implementing',
  'visualisation.mode.qa': 'Reviewing',
  'visualisation.mode.chat': 'Chatting',
  'visualisation.mode.consultee': 'Consulting',
  'visualisation.mode.finalise': 'Finalising',
  'visualisation.mode.unknown': 'Unknown',

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
  // A start or resume job dispatched but waiting for a model slot (000.03).
  'activity.status.queued': 'Waiting for model',
  'activity.status.running': 'Running',
  'activity.status.paused': 'Paused',
  'activity.status.completed': 'Completed',
  'activity.status.in-qa': 'In QA',
  'activity.status.unknown': 'Unknown',
  // `agentStatusLabel` (api/statuses.ts) elaborates a `rate_limited` pause with
  // these instead of the plain `activity.status.paused` above.
  'activity.status.rateLimited': 'Rate limited — next try {time}',
  'activity.status.rateLimited.manual': 'Rate limited — resume by hand',
  // Why an agent is paused, by `PauseReason` (`agentStatusLabel`).
  'agent.pause.user_input': 'Waiting for your reply',
  'agent.pause.consultation': "Waiting for a colleague's answer",
  'agent.pause.shutdown': 'Paused by a shutdown',
  'agent.pause.spend_cap': 'Paused — spend cap reached',
  'agent.pause.manual': 'Paused by a user',
  'agent.pause.restart': 'Paused for a restart',
  // Why a whole task is waiting, by `TaskWaitKind` (`taskWaitingLabel`).
  'task.waiting.manual': 'Paused by {name} — resume to continue',
  'task.waiting.manualAnonymous': 'Paused — resume to continue',
  'task.waiting.spend_cap':
    'Spend cap reached — resume to continue, or wait for the cap to reset',
  'task.waiting.shutdown': 'Paused by a shutdown — resume to continue',
  'task.waiting.restart': 'Paused for a restart — carries on by itself',
  'task.waiting.user_input': 'Waiting for your reply',
  'task.waiting.consultation': "Waiting for a colleague's answer",
  'task.waiting.queued': 'Waiting for the model',
  // Why the server refused a task action (`refusalKey`, api/errors.ts).
  'refusal.offline':
    "Couldn't reach the server. Check your connection and try again.",
  'refusal.forbidden': "You're not a member of this company.",
  'refusal.notFound': 'This task no longer exists.',
  'refusal.start.wrongState': 'This task has already started or finished.',
  'refusal.pause.wrongState': "This task isn't running, or is already paused.",
  'refusal.resume.wrongState': "There's nothing to resume on this task.",
  'refusal.cancel.wrongState': 'This task has already finished.',
  'refusal.edit.wrongState': "This task has started, so it can't be edited.",
  'refusal.closeVisualisation.wrongState':
    "This task hasn't finished, so its room can't be closed.",
  'refusal.start.noPlanner':
    'No planner is set for this task or its company. Choose one, then start the task.',
  'refusal.shutdown.wrongState':
    "A shutdown or restart is already under way, or restart isn't available here.",
  'refusal.shuttingDown':
    "The system is shutting down and isn't taking new work.",
  'refusal.server': 'Something went wrong on the server. Try again.',
  'refusal.failed': "That didn't work. Try again.",
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

  // The Data and Admin tabs (002.00): each a menu down the side and the
  // chosen section beside it. Data holds the record tables and links into
  // the document store; Admin holds roles, users, knowledge and data
  // protection.
  'company.tab.data': 'Data',
  'company.tab.admin': 'Admin',
  'data.menu.label': 'Data',
  'data.menu.tables': 'Tables',
  'data.menu.documents': 'Documents',
  'admin.menu.label': 'Company administration',
  'admin.menu.roles': 'Roles',
  'admin.menu.users': 'Users',
  'admin.menu.knowledge': 'Knowledge',
  'admin.menu.dataProtection': 'Data protection',
  'admin.placeholder': 'Not built yet.',
  'documents.heading': 'Documents',
  'documents.intro':
    'Folders in the document store. Each link opens the storage browser in a new tab.',
  'documents.refresh': 'Refresh the document links',
  'documents.column.folder': 'Folder',
  'documents.column.location': 'Location',
  'documents.root': 'Everything the company stores',
  'documents.resources': 'Company resources',
  'documents.taskOutputs': 'Outputs of {shortcode} — {request}',
  'documents.linkSuffix': '(opens the storage browser in a new tab)',
  'documents.unconfigured':
    'The storage browser is not configured, so there are no links to show.',
  'documents.loading': 'Loading the tasks',
  'documents.error': "The tasks' outputs could not be loaded.",

  // Record tables (001.03): the spreadsheet view, its actions and dialogs.
  'dataProtection.duties.heading': 'Your data protection duties',
  'dataProtection.duties.body':
    "If this company keeps the names, addresses or emails of customers or other people, you may have data protection duties. In the UK, you may need to pay a fee to the Information Commissioner's Office (ICO). This page doesn't give advice: check the official guidance.",
  'dataProtection.duties.link': "The ICO's guidance on the data protection fee",
  'dataProtection.scope':
    "Search, download and delete here cover the company's record tables only. They don't reach the audit log, task transcripts, knowledge, company resources, files, agents' memory or backups.",
  'dataProtection.search.heading': 'Find everything about a person',
  'dataProtection.search.label': 'Name, email or other details',
  'dataProtection.search.hint':
    'Finds rows in every table with a field containing this, in any case.',
  'dataProtection.search.submit': 'Search',
  'dataProtection.search.tooShort': 'Enter at least 2 characters.',
  'dataProtection.search.loading': 'Searching the record tables',
  'dataProtection.search.error': 'The search could not be run.',
  'dataProtection.search.none': 'No rows match "{q}".',
  'dataProtection.search.truncated':
    'Showing the first 1,000 matching rows. Make the search more specific to see the rest.',
  'dataProtection.search.group.one': '{count} matching row',
  'dataProtection.search.group.other': '{count} matching rows',
  'dataProtection.search.sheet': 'Rows in {table} matching the search',
  'dataProtection.search.downloadAll': 'Download every match',
  'dataProtection.announce.found': 'Search finished: {count} matching rows',
  'dataProtection.list.heading': 'Do-not-store list',
  'dataProtection.list.body':
    "Agents won't store a record containing any of these, as a whole word or phrase in any case. People are asked before storing one. Remove an entry if it was added by mistake or the person changes their mind.",
  'dataProtection.list.value': 'Name, email or other details not to store',
  'dataProtection.list.note': 'Note (optional)',
  'dataProtection.list.noteHint': 'Why, for example "Asked by phone on 3 May".',
  'dataProtection.list.add': 'Add to the list',
  'dataProtection.list.added': 'Added "{value}" to the do-not-store list.',
  'dataProtection.list.searchFor': 'Search the records for "{value}"',
  'dataProtection.list.filter': 'Filter the list',
  'dataProtection.list.loading': 'Loading the do-not-store list',
  'dataProtection.list.error': 'The do-not-store list could not be loaded.',
  'dataProtection.list.empty': 'The list is empty.',
  'dataProtection.list.sheet': 'Do-not-store list',
  'dataProtection.list.column.value': 'value',
  'dataProtection.list.column.note': 'note',
  'dataProtection.list.column.addedBy': 'added by',
  'dataProtection.list.column.added': 'added',
  'dataProtection.list.byAgent': 'an agent',
  'dataProtection.list.remove.one': 'Remove {count} selected entry',
  'dataProtection.list.remove.other': 'Remove {count} selected entries',
  'dataProtection.list.remove.heading': 'Remove the selected entries?',
  'dataProtection.list.remove.message':
    'Agents will be able to store records containing them again.',
  'dataProtection.list.remove.confirm': 'Remove',
  'dataProtection.announce.listChanged': 'Do-not-store list updated',
  'dataProtection.announce.listNotChanged': 'Not changed: {message}',
  'tables.loading': 'Loading the tables',
  'tables.error': 'The tables could not be loaded.',
  'tables.empty':
    'No record tables yet. Agents make them when they keep records such as orders or stock.',
  'records.tray.heading': 'Record tables',
  'records.tray.column.table': 'Table',
  'records.tray.column.records': 'Records',
  'records.tray.column.actions': 'Actions',
  'tables.choose': 'Choose a table to see and correct its records.',
  'records.count.one': '{count} record',
  'records.count.other': '{count} records',
  'records.loading': 'Loading the table',
  'records.error': 'The table could not be loaded.',
  'records.empty': 'This table has no records yet.',
  'records.truncated':
    'Showing the {shown} most recently changed of {total} records. Download the table to see them all.',
  'records.usage':
    'Spreadsheet. Arrow keys move between cells. Enter or F2 edits a cell, Enter saves and Escape cancels. Rows start most recently changed first; choose a column header to sort by that column. Changed cells are marked until you leave the table. Rows changed elsewhere are marked too, and cannot be edited until you reload.',
  'records.sheet.label': '{table} records',
  'records.column.key': '{field} (key)',
  'records.column.updated': 'Updated',
  'records.changed': '(changed)',
  'records.added': '(added)',
  'records.changedElsewhere': '(changed elsewhere, so it cannot be edited)',
  'records.deletedElsewhere': '(deleted elsewhere, so it cannot be edited)',
  'records.outOfDate.label': 'Out of date',
  'records.outOfDate.intro': 'Changed elsewhere since you opened it:',
  'records.outOfDate.changed.one': '{count} row changed',
  'records.outOfDate.changed.other': '{count} rows changed',
  'records.outOfDate.deleted.one': '{count} row deleted',
  'records.outOfDate.deleted.other': '{count} rows deleted',
  'records.outOfDate.added.one': '{count} row added',
  'records.outOfDate.added.other': '{count} rows added',
  'records.outOfDate.hint': 'Marked rows cannot be edited until you reload.',
  'records.outOfDate.reload': 'Reload',
  'records.outOfDate.dropped':
    'This table was deleted elsewhere. You can still read it here, but it cannot be changed.',
  'records.outOfDate.columns':
    "This table's columns were changed elsewhere. It cannot be edited until you reload.",
  'records.deleteRow.stale':
    'Delete row: not available, {row} changed elsewhere',
  'records.boolean.yes': 'true',
  'records.boolean.no': 'false',
  'records.download': 'Download {table} as CSV',
  'records.downloadAll': 'Download all tables as a zip',
  'records.downloadFailed': 'The download failed.',
  'records.addRow': 'Add a row to {table}',
  'records.deleteRow': 'Delete row {row}',
  'records.deleteRow.none': 'Delete row: choose a cell in the row first',
  'records.undo': 'Undo {change}',
  'records.undo.none': 'Nothing to undo',
  'records.change.edit': 'the change to {field} of {row}',
  'records.change.add': 'adding {row}',
  'records.change.delete': 'deleting {row}',
  'records.more': 'More actions for {table}',
  'records.action.append': 'Append CSV…',
  'records.action.reload': 'Reload',
  'records.action.clear': 'Clear table…',
  'records.action.drop': 'Delete table…',
  'records.append.heading': 'Append CSV to {table}',
  'records.append.file': 'CSV file',
  'records.append.hint':
    'The first line names the columns: {columns}. Rows whose key is already in the table are skipped.',
  'records.append.submit': 'Append',
  'records.append.cancel': 'Cancel',
  'records.append.noFile': 'Choose a CSV file.',
  'records.append.tooBig': 'The file is larger than 5 MB.',
  'records.append.errors': 'Nothing was added. Fix these rows and try again:',
  'records.append.errorRow': 'Row {row}: {message}',
  'records.clear.heading': 'Clear {table}?',
  'records.clear.message.one':
    'This deletes {count} record. The table stays. This cannot be undone.',
  'records.clear.message.other':
    'This deletes {count} records. The table stays. This cannot be undone.',
  'records.clear.confirm': 'Clear table',
  'records.drop.heading': 'Delete {table}?',
  'records.drop.message.one':
    'This deletes the table and its {count} record. This cannot be undone.',
  'records.drop.message.other':
    'This deletes the table and its {count} records. This cannot be undone.',
  'records.drop.confirm': 'Delete table',
  'records.downloadFirst': 'Download a copy first',
  'records.addRow.heading': 'Add a row to {table}',
  'records.addRow.submit': 'Add row',
  'records.addRow.required': 'Fill this in.',
  'records.addRow.number': 'Enter a number.',
  'records.addRow.integer': 'Enter a whole number.',
  'records.addRow.boolean': 'Enter true or false.',
  'records.addRow.hint.boolean': 'true or false',
  'records.addRow.hint.date': 'A date, as YYYY-MM-DD',
  'records.addRow.clash': 'A record with this key is already in the table.',
  'records.deleteRow.heading': 'Delete row {row}?',
  'records.deleteRow.message':
    'This deletes the record. You can undo it until you leave this table.',
  'records.deleteRow.confirm': 'Delete row',
  'records.error.generic': 'Something went wrong. Try again.',
  'records.doNotStore.heading': 'Store something on the do-not-store list?',
  'records.doNotStore.message':
    "{fields}: matches an entry on this company's do-not-store list. Someone asked for their details not to be kept. Store it anyway?",
  'records.doNotStore.confirm': 'Store anyway',
  'records.announce.doNotStoreKept':
    'Not saved: it matches the do-not-store list',
  'records.selected.download.one': 'Download {count} selected row',
  'records.selected.download.other': 'Download {count} selected rows',
  'records.selected.delete.one': 'Delete {count} selected row',
  'records.selected.delete.other': 'Delete {count} selected rows',
  'records.deleteRows.heading.one': 'Delete {count} row?',
  'records.deleteRows.heading.other': 'Delete {count} rows?',
  'records.deleteRows.message':
    "They can't be brought back, and undo won't restore them. Download a copy first if you need one.",
  'records.deleteRows.confirm': 'Delete rows',
  'records.announce.rowsDeleted': 'Rows deleted from {table}: {count}',
  'records.action.retention': 'Retention…',
  'records.action.columns': 'Columns…',
  'records.columns.heading': 'Columns of {table}',
  'records.columns.key':
    'Key: {fields}. No two rows may have the same values in all of these.',
  'records.columns.inKey': 'in the key',
  'records.columns.required': 'required',
  'records.columns.rename': 'Rename {column}',
  'records.columns.renameShort': 'Rename',
  'records.columns.delete': 'Delete {column}',
  'records.columns.deleteShort': 'Delete',
  'records.columns.keyNoDelete':
    'In a key, so it cannot be deleted. Take it out of the key first.',
  'records.columns.add': 'Add column',
  'records.columns.changeKey': 'Change key',
  'records.columns.close': 'Close',
  'records.columns.back': 'Back',
  'records.columns.name': 'Column name',
  'records.columns.nameHint':
    'Lower-case letters, digits and underscores, starting with a letter, such as animal_name.',
  'records.columns.nameMissing': 'Give the column a name.',
  'records.columns.type': 'Type',
  'records.columns.type.text': 'Text',
  'records.columns.type.number': 'Number',
  'records.columns.type.integer': 'Whole number',
  'records.columns.type.boolean': 'Yes or no',
  'records.columns.type.date': 'Date',
  'records.columns.default': 'Value for rows already in the table (optional)',
  'records.columns.defaultHint.one':
    'The {count} row already in the table gets this value. Leave it empty to leave it blank.',
  'records.columns.defaultHint.other':
    'The {count} rows already in the table get this value. Leave it empty to leave them blank.',
  'records.columns.requiredLabel': 'Required: every row must have a value',
  'records.columns.requiredHint':
    'A new column can be required only if every row gets a value, so give a value for the rows already in the table first.',
  'records.columns.addSubmit': 'Add column',
  'records.columns.newName': 'New name for {column}',
  'records.columns.renameSubmit': 'Rename',
  'records.columns.keyFields': 'Key fields',
  'records.columns.keyHint':
    'Every row needs a value in each key field, and no two rows may share them all. Only text, whole number and date columns can be in the key.',
  'records.columns.keySubmit': 'Save key',
  'records.columns.deleteHeading': 'Delete {column} from {table}?',
  'records.columns.deleteMessage.one':
    'Its value goes from the {count} row in the table. This cannot be undone.',
  'records.columns.deleteMessage.other':
    'Its value goes from all {count} rows in the table. This cannot be undone.',
  'records.columns.deleteConfirm': 'Delete column',
  'records.columns.retype': 'Change the type of {column}',
  'records.columns.retypeShort': 'Type',
  'records.columns.retypeLabel': 'New type for {column}',
  'records.columns.retypeHint':
    'Each value is converted. Numbers written as text become numbers, anything can become text, and text already written as a date (YYYY-MM-DD) or as true or false keeps its meaning.',
  'records.columns.retypeSubmit': 'Change type',
  'records.columns.blankHeading': 'Blank values in {column}?',
  'records.columns.blankMessage':
    'If you go on, those values are removed from their rows and the rest are converted. This cannot be undone.',
  'records.columns.blankConfirm': 'Blank them and change type',
  'records.columns.uniqueKeys':
    'Also unique: no two rows may have the same values in each of these.',
  'records.columns.dropUnique': 'Drop unique key {fields}',
  'records.columns.dropUniqueShort': 'Drop',
  'records.columns.addUnique': 'Add unique key',
  'records.columns.uniqueFields': 'Fields that must be unique together',
  'records.columns.uniqueHint':
    'Every row needs a value in each of these, and no two rows may share them all. Only text, whole number and date columns can be in a key.',
  'records.columns.uniqueSubmit': 'Add unique key',
  'records.columns.dropUniqueHeading': 'Drop the unique key on {fields}?',
  'records.columns.dropUniqueMessage':
    'Rows will no longer have to differ in {fields}, so the same thing could be recorded twice.',
  'records.columns.dropUniqueConfirm': 'Drop unique key',
  'records.retention.heading': 'How long {table} keeps its rows',
  'records.retention.when': 'Delete rows',
  'records.retention.never': 'Never: keep them until someone deletes them',
  'records.retention.fromUpdated': 'A number of days after their last change',
  'records.retention.fromField': 'A number of days after {field}',
  'records.retention.days': 'Days',
  'records.retention.daysHint': 'From 1 to 36500 (a hundred years).',
  'records.retention.daysInvalid': 'Enter a whole number from 1 to 36500.',
  'records.retention.note':
    'Rows are checked every hour. A row whose date is blank is kept.',
  'records.retention.save': 'Save',
  'records.retention.cancel': 'Cancel',
  'records.retention.summaryUpdated':
    'Rows are deleted {days} days after their last change.',
  'records.retention.summaryField':
    'Rows are deleted {days} days after {field}.',
  'records.announce.retentionSet': 'Retention saved for {table}',
  'records.announce.columnAdded': 'Column added to {table}: {column}',
  'records.announce.columnRenamed':
    'Column renamed in {table}: {column} is now {newName}',
  'records.announce.columnDeleted': 'Column deleted from {table}: {column}',
  'records.announce.keyChanged': 'Key of {table} is now {fields}',
  'records.announce.columnRetyped':
    'Column type changed in {table}: {column} is now {type}',
  'records.announce.uniqueKeyAdded': 'Unique key added to {table}: {fields}',
  'records.announce.uniqueKeyDropped':
    'Unique key dropped from {table}: {fields}',
  'records.announce.saved': 'Saved: {field} of {row}',
  'records.announce.notSaved': 'Not saved: {message}',
  'records.announce.stale':
    'Not saved: the record was changed elsewhere, so the table has been reloaded',
  'records.announce.added': 'Row added: {row}',
  'records.announce.deleted': 'Row deleted: {row}',
  'records.announce.undone': 'Undone: {change}',
  'records.announce.undoFailed': 'Could not undo: {message}',
  'records.announce.appended':
    'Appended to {table}: {inserted} added, {skipped} already there',
  'records.announce.cleared': 'Table cleared: {table}',
  'records.announce.dropped': 'Table deleted: {table}',
  'records.announce.reloaded': 'Reloaded: {table}',
  'records.announce.outOfDate':
    '{table} has changed elsewhere. Reload to see the changes.',
  'records.announce.droppedElsewhere': '{table} was deleted elsewhere.',
  'records.announce.columnsChanged':
    'The columns of {table} have changed elsewhere. Reload to see them.',
  'dataProtection.outOfDate.deleted.one': '{count} row no longer matches',
  'dataProtection.outOfDate.deleted.other': '{count} rows no longer match',
  'dataProtection.outOfDate.added.one': '{count} new match',
  'dataProtection.outOfDate.added.other': '{count} new matches',
  'dataProtection.outOfDate.columns':
    'The columns of a table here were changed elsewhere. Its rows cannot be edited until you reload.',
  'dataProtection.announce.outOfDate':
    'The search results have changed elsewhere. Reload to see the changes.',
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

/**
 * A key whose string has both an `.one` and an `.other` form, named without
 * the suffix — what `tCount` accepts.
 */
export type CountKey = {
  [K in StringKey]: K extends `${infer Base}.one`
    ? `${Base}.other` extends StringKey
      ? Base
      : never
    : never;
}[StringKey];

/** English plural rules, from the platform rather than a library. */
const pluralRules = new Intl.PluralRules('en');

/**
 * Resolves a counted phrase such as "1 active task" or "2 active tasks",
 * picking the form by the platform's plural rules and filling `{count}`.
 *
 * Only for phrases shown on the page. An announcement is still worded to read
 * at any count ("Tasks: {count} added"), so it stays one string and one
 * channel phrase however many items it covers.
 */
export const tCount = (key: CountKey, count: number): string =>
  t(`${key}.${pluralRules.select(count) === 'one' ? 'one' : 'other'}`, {
    count,
  });
