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
opening the page, and tests live _removal_ only — and the Activity tab for
every other viewer too, not just this one.

No prompt owns this backend fix yet.

Testable: create a task through the API while a page showing the office view
or the activity tab is open. The task does not appear until it is started or
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
`useOfficeWorld.test.tsx`.

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
Agents and Furniture both on, will stack labels on top of each other. Marked
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
| A fuller reduced-motion design for the office view                                                                                                  | 000.01    | `000.02`            |
