# ADR-020: A Window on a Running Company, Not a Control Panel

**Status:** Accepted (2026-07-30; amended — see [007.01.01](#amendments-as-implemented-007011) and [002.02 (phase 03)](#amendments-as-implemented-p03-002-02) at the end)

## Context

Every capability the TCP simulation has is reachable today through `tcp-cli` — 36 verbs covering company and role CRUD, task orchestration, chat, knowledge management, and shutdown.

The web UI adds a second client. This ADR describes the goals of the MVP.

## What needs deciding

How much of the CLI's surface should the first web release cover?

1. **The CLI will remain.** It's useful and offers more control of configuration than the MVP web UI.
2. **The web UI offers a live overview.** The terminal mode of `tcp-cli` shows one agent stream; `tcp-cli tui` offers multiple panes. The proposed web UI can go further, showing multiple live lists and conversations.
3. **The MVP is deliberately unstyled.** Visual design can wait until post-MVP. Accessibility is much more important. (See [ADR-026](ADR-026-web-ui-accessibility-and-component-library.md) and [ADR-027](ADR-027-screen-reader-strategy.md)).

## Options considered

| Option                                     | Notes                                                                                      |
| ------------------------------------------ | ------------------------------------------------------------------------------------------ |
| **Observation and interaction** _(chosen)_ | Watch a company live, and interact where a human is needed. Configuration stays in the CLI |
| Configuration first                        | The conventional order — but duplicates what the CLI already does well                     |
| Observation only, no interaction           | Smaller, and leaves a blocked agent with no way to unblock it from the browser             |
| Everything, fully styled                   | A much larger piece of work, and the plan calls for an unstyled, accessible MVP first      |

## Decision

**The MVP web app will permit observation and interaction.** Configuration is postponed until after MVP.

### What's included

| Feature                    | MVP       | Note                                                   |
| -------------------------- | --------- | ------------------------------------------------------ |
| Landing page               | Yes       | Blurb, sign-in, post-sign-out redirect target          |
| Header + account menu      | Yes       | Logo placeholder, profile, memberships, sign out       |
| Companies overview         | Yes       | Membership-scoped, with per-company stats              |
| Company view + tabs        | Yes       | Breadcrumb, tab component, one tab                     |
| Company live activity      | Yes       | Agents, tasks, consultations, enquiries; 'add new' FAB |
| Chat dialog                | Yes       | Multi-conversation, interactive, minimise-to-bar       |
| Task dialog                | Yes       | Details, per-assignment transcripts, cancel            |
| User response dialog       | Yes       | Interactive reply to an open enquiry                   |
| Task creation dialog       | Yes       | Fields mirroring the CLI's creation pane               |
| Profile dialog             | Partially | **Read-only** — see Detail                             |
| Company memberships dialog | Partially | **Read-only** — see Detail                             |
| Loading / error / empty    | Yes       | Every data-driven surface                              |
| Toast notifications        | Yes       | Background events reaching a user not on that view     |
| Company configuration view | No        | Deferred — see Detail                                  |
| Role dialog                | No        | Belongs with the configuration view                    |
| Edit company user dialog   | No        | Belongs with the configuration view                    |

Three scope choices are explained below: [why configuration is deferred](#why-configuration-is-deferred), [why two dialogs are read-only](#why-two-dialogs-are-read-only), and [why the company view is tabbed from the start](#why-the-company-view-is-tabbed-from-the-start).

This scope assumes [ADR-023](ADR-023-backend-api-surface-for-the-web-ui.md) resolves four gaps in the current API. If any is deferred, the scope has to shrink — see [API constraints](#api-constraints).

## Consequences

- The CLI is still needed. Documentation should indicate this clearly.
- A new user may see an empty companies overview. This is intentional. Until they have been 'onboarded' (linked to one or more companies as a company user), they will only see an empty list.
- Deferring the configuration view means that the role dialog, and editing of company users is also deferred. This is recorded in a post-MVP prompt, so they are not lost.
- The tab component is built and then barely used for one release. The rationale for this should be made clear in the implementation plan, to ensure that tools like ponytail, and reviewers do not flag this as unnecessary.
- Each feature/surface is scoped. If ADR-023 forces any degradations, these can be clearly recorded.

## Alternatives considered

- **Configuration first, observation second.** This is more conventional, but as `tcp-cli` already permits control of the configuration, it's sufficient (for now) that the MVP enhance the observation and interaction experience.
- **Read-only MVP — observation with no interaction.** This would be a smaller MVP, but limits productivity as interactions like user queries can block agents, assignments, and tasks with no way to unblock them through the web UI. Fallback to the CLI isn't desirable once a task is in motion.
- **Deliver everything, with full styling.** This is a significantly larger piece of work, and the plan calls for an unstyled, accessible MVP first. Remaining features and themes can be built after MVP.

## Prompts to update when this is decided

- `006.01.00.prompt - companies overview and company view shell (draft).md`
- `007.01.00.prompt - company live activity view (draft).md`
- `008.01.00` – `008.06.00` (all dialog prompts)
- `phase 03 - web visualisation/003.01.00.prompt - add new FAB and role menu.md`
- `phase 06 - web ui quality/001.02.00.prompt - accessibility audit and remediation (draft).md`
- `phase 06 - web ui quality/002.01.00.prompt - company configuration view (draft).md`

## Detail

### Why configuration is deferred

`tcp-cli` already offers a variety of verbs to control configuration:

- `set-company`
- `set-role`
- `store-knowledge`
- etc.

The MVP web app will complement the CLI by offering an improved observation experience, and permit interaction through that interface.

Building configuration forms first would spend the first release re-implementing solved problems, and delay the one thing the CLI cannot do well.

### Why two dialogs are read-only

User profile and company membership dialogs are planned. These will be read-only for the MVP, as permitting modification of this data would require new endpoints.

The data is already available without those endpoints:

- the user profile is drawn from the ID token's claims[^claims]
- company memberships come from the same membership-scoped query the companies overview uses

Read-only therefore keeps both dialogs in the MVP at almost no cost. Editing waits for the phase that adds the endpoints.

[^claims]: The ID token is the signed record of who signed in, issued by the identity provider. It carries "claims" — fields such as name and email — so the browser can display them without asking the server.

### Why the company view is tabbed from the start

Although only one tab is planned for the MVP, the company view will be a tabbed view with a single tab. Additional tabs will be added after MVP. This is a deliberate choice.

The alternative is a single-view layout that must be dismantled and rebuilt as tabs when the configuration view lands. The tab component is small; the retrofit is not, and it would land in a release that also has to get the configuration view right.

### API constraints

[ADR-023](ADR-023-backend-api-surface-for-the-web-ui.md) contains decisions that impact the MVP. Without these backend changes, the MVP would be limited:

- **Companies overview would be hard-blocked.** `GET /api/company` currently returns every company in the system with no membership filter.
- **The live activity view could not be fully live.** The company SSE[^sse] channel carries only `entity: 'company'` and `entity: 'task'` rows, so the tasks list would stream but the agents, consultations and enquiries lists would not.
- **Consultations would have no endpoint at all** — only an orphan-assignment query that approximates it.
- **Nothing will work from a browser** until CORS[^cors] or a same-origin proxy exists.

Assuming ADR-023 resolves these, the scope above stands unchanged. If any of these issues are deferred, the scope of the MVP would have to be constrained.

[^sse]: Server-Sent Events — a long-lived HTTP connection the server pushes updates down, so the browser sees changes without polling.

[^cors]: Cross-Origin Resource Sharing — the browser rule that stops a page on one address calling an API on another unless the API explicitly allows it.

---

<a id="amendments-as-implemented-007011"></a>

## Amendments as implemented (007.01.01)

007.01 built the live activity view — the "Company live activity" row's "Agents, tasks, consultations, enquiries; 'add new' FAB" — and narrowed it twice on the way.

### The 'add new' FAB is absent, not stubbed

The scope table names the FAB alongside the four lists as one feature. 007.01 shipped the four lists and nothing that opens a task or a chat: no FAB, no menu, no button. Both actions it would offer — create a task (008.05) and start a chat with a role (008.02) — open dialogs that do not exist yet, and a control whose every item is inert is worse than no control. `CompanyActivity.tsx` renders four lists and stops there.

This is not a smaller version of the row's promise; it is the row's second half, deferred whole to 001.01, which is built last for exactly this reason — it only opens dialogs that already exist by then. Revisiting this is not a condition to watch for: 001.01 is the prompt that closes the gap, on schedule.

### Agent and consultation rows are read-only

The scope table lists "agents" and "consultations" as things the view shows; it says nothing about selecting one, because the design that reached this table assumed selecting either opened an "assignment dialog." No dialog by that name is in the MVP's Decision table above — chat, task, user response, task creation, profile and memberships are the six, and none of them is scoped to a bare assignment.

007.01 chose not to add a seventh. Agent and consultation rows in `AgentsList` and `ConsultationsList` (`src/pages/CompanyPage/activity/lists.tsx`) render as plain `<li>` text, not a link or a button — there is nothing to open. Tasks and enquiries stay non-interactive only for now: their dialogs (008.03, 008.04) land later in this phase and will make their rows interactive when they do. Agents and consultations have no dialog scheduled to do the same.

This would need revisiting if a workflow turns up that only a transcript scoped to one assignment can serve — the task dialog answers "what happened on this task," and nothing answers "what happened on this one consultation" once it closes, since a consultation is by definition an assignment with no task. Until that need is concrete, the narrower surface is the one built.

<a id="amendments-as-implemented-p03-002-02"></a>

## Amendments as implemented (002.02, phase 03)

### Chat dialog: "minimise-to-bar" gains a second, real removal

The scope table's Chat dialog row describes "minimise-to-bar" as the panel's
only way off the screen. 002.02 added a per-panel **Close** button alongside
the existing minimise, following user feedback that a long session's chats
had no way to leave the dialog except by ending them. Closing removes the
panel and releases its stream; the underlying chat is untouched on the
server and stays reachable from the company's Chats list. This doesn't
widen the row's scope — the dialog is still exactly the "multi-conversation,
interactive" surface described — it corrects "minimise-to-bar" as the whole
answer to "how does a panel leave the screen." See
[web-client.md](../web-client.md#chat-dialog).

## Amendment as implemented (003.01, phase 03) <a id="amendment-as-implemented-p03-003-01"></a>

**The 'add new' FAB now exists.** [003.01](../prompts/phase%2003%20-%20web%20visualisation/003.01.00.prompt%20-%20add%20new%20FAB%20and%20role%20menu.md) closed the gap recorded above under "The 'add new' FAB is absent, not stubbed". It is a floating menu button on the company page, offering "Create a new task" and "New chat", a submenu of the company's roles. It sits on the company page rather than inside the activity view, so it is reachable from the office view too. The chat dialog carries the same menu, because the dialog is modal and would otherwise hide the page's control. See [web-client.md](../web-client.md#add-new-starting-a-task-or-a-chat).

## Amendment as implemented (000.06, phase 04) <a id="amendment-as-implemented-p04-000-06"></a>

[000.06](../prompts/phase%2004%20-%20utility/000.06.01.plan%20-%20dialog%20improvements.md) changed two things this ADR recorded about the dialogs.

- **The task dialog can now be parked.** Every dialog minimises to the dock, so 008.03's "a plain modal rather than a parkable one" no longer holds. See [ADR-026's amendment](ADR-026-web-ui-accessibility-and-component-library.md#amendment-as-implemented-p04-000-06).
- **The chat dialog's per-panel Close is gone.** The dialog is a list of views beside one selected view, with one Close for the whole dialog. A view leaves the list by being archived (a role chat is completed; listening in is only hidden) or deleted (role chats only, after a confirmation).
