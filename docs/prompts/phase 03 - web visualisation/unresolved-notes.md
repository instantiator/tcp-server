# Phase 03 — unresolved notes

Things phase 03 has left open. Not a backlog of features: this is for the
findings that would otherwise be lost — a deliberate compromise, a constraint
imposed from outside, a decision that can only be taken once something else
exists.

Every prompt in this phase ends with a directive to add to this file. A prompt
that finishes with nothing to add says so in its plan, rather than leaving the
reader to wonder whether it was checked.

## How to use it

**Work that a later prompt will do** does not belong here. Write it into that
prompt, so whoever picks it up meets it in the place they are already reading.
Add a line to [Carried into a later prompt](#carried-into-a-later-prompt) so it
is visible from here too.

**Work whose trigger is a condition, not a date** — an upstream project adding
a feature, a library dropping a peer constraint, a number crossing a threshold —
needs an entry here _and_ a memory, because nothing in this repo will ever
prompt someone to re-check it. State the condition in a form that can be tested,
not "revisit later".

**Resolve an entry by deleting it**, in the change that resolves it. An entry
kept for the record is an entry nobody trusts is current.

## Open

### Creating a task publishes no live event

**Raised by:** 000.01 · **Condition to revisit:** `TaskService.create` publishes a `ready` state_change

`TaskService.create` saves the task row and records nothing, so an open page
sees a new task only once it is started (`planning` is published) or on
reload. This affects the office view — its browser spec creates a task before
opening the page, and tests live _removal_ only — and the Tasks tab for
every other viewer too, not just this one.

No prompt owns this backend fix yet.

Testable: create a task through the API while a page showing the office view
or the Tasks tab is open. The task does not appear until it is started or
the page is reloaded.

### No browser-tier coverage of agent avatars

**Raised by:** 000.01 · **Condition to revisit:** stub-llm (or any LLM) becomes part of the browser-tier deployment

The browser-tier deployment has no LLM — `tcp-stub-llm` only runs under the
`integration` compose profile — so no agent ever runs there, and no journey
can watch an agent avatar walk, work or leave. Roles, task rooms and every
pointer and keyboard interaction are proven against real Phaser. Agent
avatars are proven instead by unit tests on the pure rules and motion, plus
one component-tier pipeline test in `useOfficeWorld.test.tsx` that drives a
full agent lifecycle (created, running, completed, task cancelled, arrival
and exit) through fetch-mock and `applyEvent`. This was a decision taken
before planning, not an oversight: see 000.01's plan.
002.01's role pickup (door, then the role's book, then the desk) is covered
the same way: unit tests on the rules and one pipeline case in
`useOfficeWorld.test.tsx`. 002.02's carry-to-archive is the same gap by the
same cause: no browser test covers a succeeded task's archive link, because
driving a task to `succeeded` by hand would race the real BullMQ job each
stage dispatches the moment its assignment is created — see 002.02's plan,
stage 11. The bookshelf tray's browser spec covers its empty state instead,
which still proves the tray reads its live `storageConsoleUrl`/
`storageBucket` config. 005.01's thought bubbles are the same gap by the same
cause: they show only over a working agent, so they are covered by unit tests
on the layer and its animation steps, and by one `CompanyVisualisation`
pipeline test from a running agent to `openChat`.

Testable: the browser-tier deployment's compose services include an LLM.

### The canvas ignores the high-contrast theme

**Raised by:** 000.01 · **Condition to revisit:** the accessibility audit (phase 04, `001.02`) runs, or the theme set changes

Every colour in the office view — room floors, walls, furniture, avatars —
comes from `scene/palette.ts`, a fixed set of values. None of it resolves
through a `--tcp-*` token, so switching to the high-contrast theme changes
nothing on the canvas. This was a deliberate 000.01 trade — placeholder
shapes, not a themed design system — recorded rather than left for someone to
find by accident.

Testable: switch to the high-contrast theme and look at the office view; the
canvas is unchanged.

### Layout ceilings: 28 role spots, 8 desks per task room

**Raised by:** 000.01 · **Condition to revisit:** a company with more than 28 roles, or a task with more than 8 concurrent avatars

`roleSpots()` gives the rec room 28 tiles (the interior, minus the door column
and the two sofas), and `MAX_DESKS_PER_ROOM` caps a task room at 8. A role
past the 28th is not placed at all; an avatar with no free desk stands by the
whiteboard instead. Both are marked `ponytail:` in `world/furnishing.ts` —
growing the room is the intended upgrade, not a smarter packing of the
existing one.

Testable: a company with 29 roles, or a task running 9 concurrent avatars.

### Unbounded lists

**Raised by:** 000.01 · **Condition to revisit:** the agent, task or assignment list endpoints gain pagination or status filters, or a company's history makes the page visibly slow

`useOfficeWorld` fetches every agent, task and assignment the company has ever
had — the list endpoints return every row ever, not just the active ones —
and `buildCompanySnapshot` scans all of them on every change. This matches
how the activity view already works, and is fine while a company's history is
small.

Testable: open the office view on a company with a long history and watch
whether it becomes visibly slow to update.

### The rules avoid `agent.pauseReason`

**Raised by:** 000.01 · **Condition to revisit:** live agent events carry a full summary

`companySnapshot.ts`'s activity mapping deliberately reads whether an agent is
consulting or messaging the user from the consultee assignment and the open
enquiries, never from `agent.pauseReason`. A live agent event patches only
`status` into the cached row, so `pauseReason` goes stale the moment an agent
changes state after the page loaded. See the memory
`project-live-agent-rows-no-summary`.

Testable: `grep -rn "entity: 'agent'" apps/backend --include=*.ts` shows a
`summary` alongside every write.

### The picker's list can change while it is open

**Raised by:** 000.01 · **Condition to revisit:** the accessibility audit (phase 04, `001.02`) runs

The "Show details for…" picker lists the snapshot's roles, unfinished tasks
and active agents live. If a task or agent arrives while the picker is open,
its list changes under the user — which is exactly what ADR-027's "live
updates never reorder what's under the cursor" rule warns about, applied here
to a picker rather than a list.

Testable: open the picker, create or finish a task from another session, and
check whether the open list moves under the keyboard cursor.

### A desk added under a standing avatar

**Raised by:** 000.01 · **Condition to revisit:** real furniture art makes it noticeable

A new desk can be added to a task room at a tile a role avatar's placeholder
shape already occupies, if that avatar happens to be standing there. It stays
drawn inside the desk until it next moves. Cosmetic only, and invisible with
today's placeholder shapes.

Testable: real sprite art for desks and avatars exists, and the overlap is
now visible.

### Canvas labels aren't laid out

**Raised by:** 002.01 · **Condition to revisit:** labels in a busy room become unreadable in ordinary use

`scene/LabelLayer.ts` puts each label above its anchor and does nothing when
two overlap. A task room with several avatars at neighbouring desks, with
Agents and Furniture both on, will stack labels on top of each other. Since
005.01 an agent label can also overlap its own thought bubble's cloud. Marked
`ponytail:` in the file; the upgrade is nudging overlapping labels apart, or
showing furniture labels only on hover.

Testable: turn on every label in a task room with three or more avatars and
read them.

### Overlays use a deprecated portal prop

**Raised by:** 002.01 · **Condition to revisit:** react-aria-components exports `UNSAFE_PortalProvider`, or drops `UNSTABLE_portalContainer`

The office view's toolbar tooltips and the picker's popover portal into the
view's own section through `UNSTABLE_portalContainer` (deprecated), so they
show in full screen and stay inside the page's landmarks. Its replacement,
`UNSAFE_PortalProvider`, lives in `react-aria`, which react-aria-components
pins at an exact version and doesn't re-export; importing it directly would
need a second dependency kept in lock-step, which fails silently when the
two drift. The deprecated prop fails loudly — a type error — if it is ever
removed. Both uses carry an `eslint-disable` for `no-deprecated` that points
here.

Testable: `grep -c UNSAFE_PortalProvider node_modules/react-aria-components/dist/types/exports/index.d.ts`
prints more than 0.

### `hosting.spec.ts` fails under `--dev-web`

**Raised by:** 000.01 · **Condition to revisit:** none — standing note

`hosting.spec.ts` only holds for a built bundle, so it fails when the
deployment is started with `--dev-web` (Vite serving the frontend directly).
This is not a regression from 000.01; it is a standing fact for anyone running
the browser tier this way. The full browser tier must run against a built
deployment.

### Browser tier: an occasional redirect to Zitadel's login form

**Raised by:** 000.01 · **Condition to revisit:** it happens again, in any spec.

Once in about thirteen runs of `company-visualisation.spec.ts`, three tests failed together: their pages were sent to Zitadel's login form (`/ui/login/login?authRequestID=…`) instead of back into the app, so no data loaded. The signed-in state comes from Zitadel's session cookie, which the setup project saves; every page load goes through a silent redirect. It could not be reproduced on demand, and the same period also had a real, now fixed slug collision in `company-activity.spec.ts` that made failures look more common than they were.

Testable: run the whole browser tier ten times. Any failure whose call log shows `ui/login/login` is this.

### The agent stream's subscribe-time replay can race a live event (C3)

**Raised by:** 002.02 · **Condition to revisit:** a stale `idle` is ever seen after a listen-in starts

`api.agent.controller.ts`'s agent stream reads the agent's status from the
database at subscribe time and replays it as a synthetic event, so a late
subscriber sees where things stand rather than nothing. If that read races a
real `state_change` landing at the same moment, the stale reading could in
principle arrive after the live one and read backwards. 002.02's
reproduction (recorded SSE streams and DB state side by side, twice) didn't
hit this — both replays agreed with the database throughout — so it's
recorded rather than fixed speculatively. See
[ADR-025's amendment](../../ADRs/ADR-025-browser-event-stream-consumption.md#amendment-as-implemented-p03-002-02).

Testable: open a listen-in on an agent at the exact moment it changes
status, and check whether the tray or transcript ever shows the older
status after the newer one.

### An event between company-stream priming and the live subscription can be lost on reconnect (C4)

**Raised by:** 002.02 · **Condition to revisit:** a status is reported missing after a reconnect

`api.company.controller.ts` awaits `prime()` — sending one row per current
task, active agent, open consultation and open enquiry — before it starts
forwarding live events. A `state_change` published in the gap between the
primed snapshot being read and the live subscription starting would reach
neither. 002.02's reproduction didn't see the company stream reconnect at
all, so this gap never opened in either recorded run. See
[ADR-025's amendment](../../ADRs/ADR-025-browser-event-stream-consumption.md#amendment-as-implemented-p03-002-02).

Testable: force a company-stream reconnect (network drop, tab backgrounded
then foregrounded) at the same moment a status changes server-side, and
check whether the office view or activity lists ever miss it.

### The archive's "finishing agent" is a recency rule, not the true finisher

**Raised by:** 002.02 · **Condition to revisit:** the wrong avatar is visibly seen carrying a task's outputs

The avatar that carries a succeeded task's outputs to the bookshelf is
whichever avatar in the room most recently dissociated from the task
(tracked by a world-wide sequence counter), falling back to one that still
holds a live agent if none has left yet. This is a deliberate proxy, not the
"true" finishing agent by assignment order — a QA reviewer who leaves last
would carry outputs from work an earlier implementer actually finished. It
reads correctly in the ordinary case (the last avatar in the room really did
just finish something), and was accepted as good enough rather than plumbing
through which assignment closed the task.

Testable: watch which avatar picks up the box on a task with several
avatars, and check whether it's the one that actually completed the
task-closing assignment.

### Silo's console link format was confirmed against one image tag

**Raised by:** 002.02 · **Condition to revisit:** the `pgsty/silo` image is bumped, or an archive link ever lands on the bucket root instead of the task's folder

The archive tray's Silo links use `{consoleUrl}/browser/{bucket}/{encodeURIComponent(prefix)}`
— percent-encoded, not MinIO's classic base64-encoded console format. This
was confirmed by hand against a running `pgsty/silo` container on
2026-09-28: a base64 prefix left the browser on the bucket root, reading the
encoded string as a literal folder name, while the percent-encoded form
round-tripped correctly. Nothing pins the image tag this was checked
against, so a future Silo release could silently change the format again.
See [shared-storage.md](../../shared-storage.md#links-from-the-web-clients-archive-tray).

Testable: click an archive tray link after a Silo image bump, and check it
opens the task's `completed/` folder rather than the bucket root.

### The Chats list has no concept of "my chats"

**Raised by:** 002.02 · **Condition to revisit:** a user asks to see only chats they started

`ChatsList` (the Chats tab) shows every chat in the company, filterable
by status and role, because the backend records no chat owner — a
chat-mode assignment carries no `createdBy`/`userId` field to filter on.
This matches how every other activity list works today (company-wide, not
per-viewer), so it wasn't treated as a gap to close in 002.02.

Testable: a user with several colleagues in the same company asks to filter
the Chats list down to just their own.

### The TUI seeds active agents only, so a finished agent's task pane starts blank

**Raised by:** 002.02 · **Condition to revisit:** a task pane shows a blank agent status for an assignment with a live (non-terminal) agent

The TUI's task panel seeds each assignment's `[agent: …]` label from
`GET /api/agent?companyId=`, which lists active agents only — an agent whose
assignment is already `succeeded`/`failed`/`cancelled` isn't in that list,
so its pane opens with no agent label. This wasn't treated as a gap: the
assignment's own status already shows the outcome, and every state after
that point is covered live from the company's SSE stream. The condition
above is deliberately narrower than "any finished agent" — it only needs
revisiting if a pane ever shows blank for an agent that's actually still
running, which seeding-from-the-active-list would not explain.

Testable: open a task pane for an assignment whose agent is currently
`running`, `paused` or `in-qa` and check the `[agent: …]` label is never
blank.

### The "Add new" button is hidden in full screen

**Raised by:** 003.01 · **Condition to revisit:** a user in the office view's full-screen mode wants to create a task

Full screen shows only the office view's own section, so the page's floating
"Add new" button isn't in it. Starting a chat is still possible there from a
role's tray ("Chat with {role}"). Creating a task is not.

Testable: enter full screen on the office view and look for a way to create a
task without leaving it.

### The office view's tray has no exit animation

**Raised by:** 005.01 · **Condition to revisit:** a user asks for the tray to slide out as well as in

The tray slides in over the canvas with `@starting-style`, but it unmounts on
close, so it vanishes rather than sliding out. Marked `ponytail:` in
`CompanyVisualisation.css`; the upgrade is keeping it mounted in a closing
state until its transition ends.

Testable: open and close the tray, and watch whether it slides out.

## Carried into a later prompt

| Note                                                                                                                                                | Raised by | Goes to             |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------- |
| No browser-tier coverage of agent avatars; decide whether stub-llm joins the browser deployment                                                     | 000.01    | `001.01` (phase 04) |
| Once `TaskService.create` publishes a live event, add live task-creation journeys to `company-visualisation.spec.ts` and `company-activity.spec.ts` | 000.01    | `001.01` (phase 04) |
| The canvas palette ignores the high-contrast theme                                                                                                  | 000.01    | `001.02` (phase 04) |
| The picker's list can change while it is open                                                                                                       | 000.01    | `001.02` (phase 04) |
| The office stage's focus and description, checked with a real screen reader                                                                         | 000.01    | `001.02` (phase 04) |
| The tooltip against WCAG 1.4.13                                                                                                                     | 000.01    | `001.02` (phase 04) |
| Furniture and doorway tooltips are pointer-only                                                                                                     | 002.01    | `001.02` (phase 04) |
| The icon-only pan and full-screen controls, checked with voice control                                                                              | 002.01    | `001.02` (phase 04) |
| The office view's documentation (`web-client.md`) and its ADR-027 amendment                                                                         | 000.01    | `001.03` (phase 04) |
| The office view's floating controls: focus order and the new icon buttons, checked with voice control                                               | 005.01    | `001.02` (phase 04) |
| The office view's thought bubbles are pointer-only; confirm the picker → tray → "Listen in" route                                                   | 005.01    | `001.02` (phase 04) |
| A fuller reduced-motion design for the office view                                                                                                  | 000.01    | `000.02`            |
