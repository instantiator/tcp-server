# ADR-020: A Window on a Running Company, Not a Control Panel

**Status:** Proposed (2026-07-30)

## Context

Every capability the TCP simulation has is reachable today through `tcp-cli` —
36 verbs covering company and role CRUD, task orchestration, chat, knowledge
management, and shutdown. The web UI adds a second client. The question this
ADR answers is not _what could it do_ (eventually, everything the CLI does) but
_what does the first cut do_, and why that boundary and not another.

Three facts shape the answer:

1. **The CLI is not going away.** It is the tool of record for setup and
   configuration, and it is scriptable. Anything the CLI already does well is a
   weak candidate for the first web release.
2. **The web UI's distinctive advantage is _watching_.** A terminal can show one
   agent's stream at a time; `tcp-cli tui` works hard to do more. A browser can
   show four live lists and several conversations at once, and can keep them
   updating while the user reads. That is the capability the CLI cannot match.
3. **The MVP is deliberately unstyled.** Per the originating prompt, visual
   design is deferred; accessibility is the quality bar instead (see
   [ADR-026](ADR-026-web-ui-accessibility-and-component-library.md) and
   [ADR-027](ADR-027-screen-reader-strategy.md)).

## Decision

**The MVP observes and interacts. It does not configure.**

### What ships

| Surface                    | MVP     | Note                                                   |
| -------------------------- | ------- | ------------------------------------------------------ |
| Landing page               | Yes     | Blurb, sign-in, post-sign-out redirect target          |
| Header + account menu      | Yes     | Logo placeholder, profile, memberships, sign out       |
| Companies overview         | Yes     | Membership-scoped, with per-company stats              |
| Company view + tabs        | Yes     | Breadcrumb, tab component, one tab                     |
| Company live activity      | Yes     | Agents, tasks, consultations, enquiries; 'add new' FAB |
| Chat dialog                | Yes     | Multi-conversation, interactive, minimise-to-bar       |
| Task dialog                | Yes     | Details, per-assignment transcripts, cancel            |
| User response dialog       | Yes     | Interactive reply to an open enquiry                   |
| Task creation dialog       | Yes     | Fields mirroring the CLI's creation pane               |
| Profile dialog             | Partial | **Read-only** — see below                              |
| Company memberships dialog | Partial | **Read-only** — see below                              |
| Loading / error / empty    | Yes     | Every data-driven surface                              |
| Toast notifications        | Yes     | Background events reaching a user not on that view     |
| Company configuration view | No      | Deferred — see below                                   |
| Role dialog                | No      | Belongs with the configuration view                    |
| Edit company user dialog   | No      | Belongs with the configuration view                    |

### The configuration view is deferred, and that is deliberate

Building a product normally starts with configuration: you cannot watch a
company that does not exist. Here that reasoning does not apply, because
`tcp-cli set-company`, `set-role`, `store-knowledge` and friends already create
and configure everything the live view needs. Shipping a web form for work the
CLI does today would spend the first release re-implementing solved problems,
and would delay the one thing the CLI cannot do.

The cost is real and worth stating: an MVP user cannot onboard entirely in the
browser. They need the CLI at least once. That is acceptable for a tool whose
operators already have it installed.

### Read-only where a write would need a new endpoint

The profile and memberships dialogs display data the browser can already
obtain — profile from the ID token's claims, memberships from the same
membership-scoped query the companies overview uses. Making either editable
would require user-management endpoints that do not exist. Read-only keeps both
dialogs in the MVP at near-zero cost; editing waits for the phase that adds the
endpoints.

### Tabs now, with one tab

The company view ships a real tab component showing a single tab. This looks
like over-building and is not: the alternative is a bare single-view layout that
must be dismantled and rebuilt as tabs the moment the configuration view lands.
The tab component is small, the retrofit is not, and the retrofit would land in
a release that also has to get the configuration view right.

### Four API gaps constrain this scope

The MVP as specified is not deliverable against tcp-server as it stands today.
[ADR-023](ADR-023-backend-api-surface-for-the-web-ui.md) owns the decisions; the
scope consequences are:

- **Companies overview is hard-blocked.** `GET /api/company` returns every
  company in the system with no membership filter.
- **The live activity view is one-quarter live.** The company SSE channel
  carries only `entity: 'company'` and `entity: 'task'` rows, so the tasks list
  streams and the agents, consultations and enquiries lists do not.
- **Consultations have no endpoint at all** — only an orphan-assignment query
  that approximates one.
- **Nothing works from a browser** until CORS or a same-origin proxy exists.

If ADR-023 resolves these, the scope above stands unchanged. If any is deferred,
the corresponding surface degrades to polling or drops out of the MVP — and
this table is where that gets recorded.

## Alternatives considered

- **Configuration first, observation second.** The conventional order, and the
  one that would apply if this were a greenfield product. Rejected: it spends
  the first release duplicating `tcp-cli` and defers the only capability the web
  client adds.

- **Read-only MVP — observation with no interaction.** Genuinely smaller, and it
  would sidestep the chat and enquiry surfaces entirely. Rejected because
  answering an agent's question is the point at which a human is _required_;
  a UI that can show you a blocked agent but not unblock it makes the CLI
  mandatory for the one workflow that is time-sensitive.

- **Ship the whole component list, styled.** Rejected by the originating prompt's
  own framing: an unstyled, accessible MVP now, with theming and the remaining
  surfaces in later phases.

## Consequences

- The CLI remains required for onboarding. Documentation must say so plainly
  rather than leaving a user to discover it at the empty-state.
- The companies overview's empty state is a first-class surface, not an
  afterthought — for a new user with no memberships it is the _entire_
  application.
- Deferring the configuration view defers the role dialog and edit-company-user
  dialog with it; they are recorded in the post-MVP prompt so they are not lost.
- The tab component is built and then barely used for one release. Accepted
  above; the rationale belongs inline in the implementing prompt, or a reviewer
  will reasonably flag it as unnecessary.
- Scope is stated per-surface, so a degradation forced by ADR-023 has an
  obvious home to be recorded in rather than becoming folklore.

## Prompts to update when this is decided

- `006.01.00.prompt - companies overview and company view shell (draft).md`
- `007.01.00.prompt - company live activity view (draft).md`
- `008.01.00` – `008.07.00` (all dialog prompts)
- `009.02.00.prompt - accessibility audit and remediation (draft).md`
- `010.01.00.prompt - company configuration view (draft).md`
