# ADR-027: Screen Reader Strategy for Live and Data-Rich Views

**Status:** Proposed (2026-07-30)

## Context

[ADR-026](ADR-026-web-ui-accessibility-and-component-library.md) sets the standard and the tooling. This ADR answers a question no automated tool can: when four lists and several transcripts are changing continuously, **what should a screen reader user actually hear?**

## What needs deciding

The originating prompt poses it as two choices:

- **For data-rich views** — expose every component and let the screen reader read the view as it sees fit, or suppress normal reading and provide a curated summary.
- **For live changes** — let new and updated components be read as they arrive, or suppress that and announce a summary of the change.

Taken at face value these look like either/or decisions. They aren't, and treating them that way produces the two classic failure modes: a view that announces everything is unusable within seconds, and a view that suppresses everything can't be navigated at all.

The specific hazard here is the streaming transcript. Agent responses arrive word by word. Announced as they arrive, one response produces hundreds of interruptions. **This is the single thing that must not happen.**

## Options considered

| Axis            | Option A                               | Option B                         |
| --------------- | -------------------------------------- | -------------------------------- |
| Data-rich views | Expose everything, read as it sees fit | Suppress, give a curated summary |
| Live changes    | Announce each change as it arrives     | Announce a coalesced summary     |

## Decision

**Expose everything for browsing; curate what gets announced. These are two different channels, not two settings of one.**

So: **option A for exposure, option B for announcement.**

- **The page is fully navigable.** Nothing is hidden from the screen reader's virtual cursor. Screen reader users explore by browsing, and suppressing content to "simplify" removes the very thing they navigate with.
- **Announcements are separate and curated.** A [live region](#one-announcer-not-scattered-live-regions) carries a small number of useful, coalesced statements — not a running commentary on every change.

The policy is applied per surface — see the [per-surface policy table](#per-surface-policy).

Three rules make it workable:

1. **Never announce a partial response.** Words render on screen as they arrive; the announcement happens once, when the response is complete.
2. **[Coalesce and throttle](#coalescing-and-throttling) per region.** Under a burst, the user hears one sentence, not six.
3. **Announce what changed, not the new state.** "Tasks: 2 added" is useful; re-reading the whole list is not.

Two supporting decisions: [focus is managed at exactly four points](#focus-is-managed-at-four-points), and [live updates never reorder what's under the cursor](#live-updates-never-reorder-the-list).

## Consequences

- The announcer is application infrastructure and must exist before the first live surface. Retrofitted, every component that grew its own live region needs unpicking.
- Throttle intervals are guesses until tested with a real screen reader. They're configurable constants, and the manual pass tunes them.
- Coalescing means announcements lag reality by up to the interval. That's correct — the visual view is live, and the audio channel summarises it.
- **A completed response can be long.** An agent's answer may run to several paragraphs, and announcing all of it is disruptive in a different way. The implementation should consider announcing only that a response arrived, leaving the content to be browsed. Flagged as **unresolved** until the manual pass — it needs real listening to judge.
- Stable list ordering conflicts with "most recently active first", which is the obvious visual design. Stability wins; recency ordering would need an explicit control rather than automatic reordering.
- A toast is never the only notice of an event — the underlying list must also reflect it (following ADR-026's "no timing" criterion).
- **This is the ADR most likely to be quietly dropped under delivery pressure**, because nothing fails a build when it is. That's what ADR-026's manual matrix is for.

## Alternatives considered

- **Expose everything, announce everything.** The naive reading of "let the screen reader read it as it sees fit". Rejected: with word-by-word streaming it produces continuous interruption, and the screen reader has no way to know which of a hundred changes mattered.
- **Suppress the view, announce only summaries.** The other pole. Rejected because it removes browsing — a user who hears "3 tasks running" and then can't explore those tasks has less access than before. Suppression also hides content from other assistive technology that relies on the same information.
- **A live region per component.** The path of least resistance during implementation, and the reason live-region output is so often unusable. Rejected in favour of one announcer — see [Detail](#one-announcer-not-scattered-live-regions).
- **A user-configurable verbosity setting.** Genuinely useful, and deferred: it assumes a sensible default to vary from, which is what this ADR establishes. Worth revisiting once the manual pass has tuned the defaults.

## Prompts to update when this is decided

- `003.03.00.prompt - shared ui states, notifications and accessibility primitives (draft).md`
- `007.01.00.prompt - company live activity view (draft).md`
- `008.01.00.prompt - dialog framework and event transcript components (draft).md`
- `008.02.00.prompt - chat dialog (draft).md`
- `008.03.00.prompt - task dialog (draft).md`
- `008.04.00.prompt - user response dialog (draft).md`
- `008.07.00.prompt - add new FAB and role menu (draft).md`
- `009.02.00.prompt - accessibility audit and remediation (draft).md`

## Detail

### Per-surface policy

"Politeness" is the screen reader convention for whether a message waits its turn (`polite`) or interrupts immediately (`assertive`).

| Surface                                                       | Exposure                                           | Announcement                                                         | Politeness                       |
| ------------------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------- |
| Live activity lists (agents, tasks, consultations, enquiries) | Labelled region, heading and item count; browsable | Coalesced per list, throttled: "Tasks: 2 added, 1 completed"         | `polite`                         |
| Streaming chat transcript                                     | Each entry an article, with author and timestamp   | **Never word by word.** One announcement when the response completes | `polite`                         |
| Agent status changes                                          | In the agents list                                 | Folded into that list's coalesced summary                            | `polite`                         |
| New user enquiry                                              | In the enquiries list                              | Announced individually — it's a request for the user to act          | `polite`                         |
| Toast notifications                                           | Visible, and mirrored into the live region         | Announced once, on appearance                                        | `polite`, `assertive` on failure |
| Errors, in context                                            | Next to the failed surface                         | Immediate                                                            | `assertive`                      |
| Loading                                                       | Region marked busy                                 | Completion only, and only if it took over ~1s                        | `polite`                         |
| Empty states                                                  | Normal content with a heading                      | None — reached by browsing                                           | —                                |
| Dialog open                                                   | Modal, labelled by its heading                     | None — the focus move is the announcement                            | —                                |
| Dialog close                                                  | —                                                  | None                                                                 | —                                |
| Route change                                                  | —                                                  | Page title, after focus moves to the main heading                    | `polite`                         |
| FAB and role submenu                                          | Standard menu-button pattern                       | None — the pattern handles it                                        | —                                |

### Coalescing and throttling

Each live list accumulates its changes and emits at most one announcement per interval. ~10 seconds is the starting point, tuned during the manual pass.

Under a burst — a task fanning out to six assignments — the user hears one sentence, not six.

### One announcer, not scattered live regions

A single application-level announcer owns the polite and assertive regions. React Aria's live announcer ([ADR-026](ADR-026-web-ui-accessibility-and-component-library.md)) provides the primitive. Components request announcements through it, rather than each mounting its own live region.

Scattered live regions are the standard way this goes wrong:

- a region mounted at the same time as its content announces its entire contents on mount
- several regions updating together produce interleaved, unreadable output

### Focus is managed at four points

- **Dialog open** — first focusable element, or the heading
- **Dialog close** — back to whatever opened it
- **Route change** — the main heading, which must be programmatically focusable
- **Destructive completion**, such as closing a chat — a stable neighbouring element, never the page body

Moving focus anywhere else — including "helpfully" onto newly arrived content — steals the cursor from someone who was reading something else.

### Live updates never reorder the list

A list that re-sorts as items change status moves content out from under someone mid-read.

Lists keep a stable sort: new items append, and status changes update in place.
