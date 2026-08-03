# ADR-020: A Window on a Running Company, Not a Control Panel

**Status:** Accepted (2026-07-30)

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
- `008.01.00` – `008.07.00` (all dialog prompts)
- `009.02.00.prompt - accessibility audit and remediation (draft).md`
- `010.01.00.prompt - company configuration view (draft).md`

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
