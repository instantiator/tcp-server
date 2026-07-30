# ADR-027: Screen Reader Strategy for Live and Data-Rich Views

**Status:** Proposed (2026-07-30)

## Context

[ADR-026](ADR-026-web-ui-accessibility-and-component-library.md) sets the
standard and the tooling. This ADR answers a question no automated tool can:
when four lists and several transcripts are changing continuously, **what should
a screen reader user actually hear?**

The originating prompt poses it as two choices:

- _For data-rich views_ — expose every component and let the screen reader read
  the view as it sees fit, or suppress normal reading and provide a curated
  summary.
- _For live changes_ — let new and updated components be read as they arrive, or
  suppress that and announce a summary of the change.

Taken at face value both look like either/or decisions. They are not, and
treating them as such produces the two classic failure modes: a view that
announces everything is unusable within seconds, and a view that suppresses
everything is unnavigable.

The specific hazard here is the streaming transcript. `StreamDelta` events
arrive token by token. Announced as they arrive, a single agent response
produces hundreds of interruptions and renders the application unusable — this
is the one thing that must not happen.

## Decision

**Expose everything for browsing; curate what gets announced. These are two
different channels, not two settings of one.**

The DOM is fully and semantically navigable — nothing is hidden from the virtual
cursor, nothing is `aria-hidden` to reduce noise. Screen reader users explore by
browsing, and suppressing content to "simplify" removes the very thing they
navigate with.

Announcements are separate and curated. A live region carries a small number of
useful, coalesced statements — not a transcript of every mutation.

This resolves both of the prompt's questions: **option 1 for exposure, option 2
for announcement.**

### Per-surface policy

| Surface                                                       | Exposure                                                              | Announcement                                                    | Politeness                                           |
| ------------------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------- |
| Live activity lists (agents, tasks, consultations, enquiries) | Each a labelled region with a heading and item count; fully browsable | Coalesced per list, throttled: "Tasks: 2 added, 1 completed"    | `polite`                                             |
| Streaming chat transcript                                     | Each entry an article with author and timestamp                       | **Never per token.** One announcement when a response completes | `polite`                                             |
| Agent status changes                                          | In the agents list                                                    | Folded into that list's coalesced summary                       | `polite`                                             |
| New user enquiry                                              | In the enquiries list                                                 | Announced individually — it is a request for the user to act    | `polite`                                             |
| Toast notifications                                           | Visible, and mirrored into the live region                            | Announced once, on appearance                                   | `polite`, or `assertive` for failures needing action |
| Errors (in-context)                                           | Adjacent to the failed surface, `role="alert"`                        | Immediate                                                       | `assertive`                                          |
| Loading                                                       | `aria-busy` on the region                                             | Completion only, and only if it took over ~1s                   | `polite`                                             |
| Empty states                                                  | Normal content with a heading                                         | None — reached by browsing                                      | —                                                    |
| Dialog open                                                   | `aria-modal`, labelled by its heading                                 | None — the focus move is the announcement                       | —                                                    |
| Dialog close                                                  | —                                                                     | None                                                            | —                                                    |
| Route change                                                  | —                                                                     | Page title, after focus moves to the main heading               | `polite`                                             |
| FAB and role submenu                                          | Standard menu-button pattern                                          | None — the pattern handles it                                   | —                                                    |

### Three rules that make this workable

**Never announce a `StreamDelta`.** Deltas render visually as they arrive and are
announced only as a completed message when the response terminates. This is the
single most important rule in this ADR.

**Coalesce and throttle per region.** Each live list accumulates its changes and
emits at most one announcement per interval (~10s is the starting point, tuned
during the manual pass). Under a burst — a task fanning out to six assignments —
the user hears one sentence, not six.

**Announce what changed, not the new state.** "Tasks: 2 added" is useful;
re-reading the whole list is not.

### One announcer, not scattered live regions

A single application-level announcer owns the polite and assertive regions.
React Aria's `@react-aria/live-announcer` (ADR-026) provides the primitive.
Components request announcements through it rather than each mounting its own
`aria-live` element.

Scattered live regions are the standard way this goes wrong: regions
mounted at the same time as their content announce their entire contents on
mount, and several regions updating together produce interleaved, unreadable
output.

### Focus is managed at four points, and nowhere else

Dialog open (first focusable element, or the heading); dialog close (back to the
trigger); route change (the main heading, which must be programmatically
focusable); and destructive completion such as closing a chat (a stable
neighbouring element, never the document body). Moving focus anywhere else —
including "helpfully" onto newly-arrived content — steals the cursor from a user
who was reading something else.

### Live updates never reorder what is under the cursor

A list that re-sorts as items change status moves content out from under
someone mid-read. Lists keep a stable sort; new items append, and status changes
update in place.

## Consequences

- The announcer is application infrastructure and must exist before the first
  live surface. Retrofitted, every component that grew its own `aria-live`
  region needs unpicking.
- Throttling intervals are guesses until tested with a real screen reader. They
  are configurable constants, and the manual pass tunes them.
- Coalescing means announcements lag reality by up to the interval. Correct: the
  visual view is live, and the audio channel is a summary of it.
- **A completed-response announcement can be long.** An agent's answer may be
  several paragraphs. Announcing the whole thing at `polite` is disruptive in a
  different way; the implementing prompt should consider announcing only that a
  response arrived, leaving the content to be browsed. Flagged as unresolved
  until the manual pass — it is a judgement that needs real listening.
- Stable list ordering conflicts with "most recently active first", which is the
  obvious visual design. Stability wins; if recency ordering is wanted later it
  needs an explicit re-sort control rather than automatic reordering.
- Adopting AA 2.2.3 (ADR-026) means a toast is never the only notice of an
  event — the underlying list must also reflect it.
- This ADR is the one most likely to be quietly ignored under delivery pressure,
  because nothing fails a build when it is. That is what the manual matrix in
  ADR-026 is for.

## Alternatives considered

- **Expose everything, announce everything.** The naive reading of "let the
  screen reader read it as it sees fit". Rejected: with token-level deltas it
  produces continuous interruption, and the assistive technology has no way to
  know which of a hundred changes mattered.
- **Suppress the view, announce only summaries.** The other pole in the prompt.
  Rejected because it removes browsing. A user who hears "3 tasks running" and
  cannot then explore those tasks has less access than before, and suppression
  via `aria-hidden` also hides content from other AT that relies on the same
  tree.
- **Per-component live regions.** The path of least resistance during
  implementation, and the reason live-region output is so often unusable —
  mount-time announcements and interleaving. Rejected in favour of one announcer.
- **A user-configurable verbosity setting.** Genuinely useful and deferred: it
  presumes a sensible default exists to vary from, which is what this ADR
  establishes. Worth revisiting once the manual pass has tuned the defaults.

## Prompts to update when this is decided

- `003.03.00.prompt - shared ui states, notifications and accessibility primitives (draft).md`
- `007.01.00.prompt - company live activity view (draft).md`
- `008.01.00.prompt - dialog framework and event transcript components (draft).md`
- `008.02.00.prompt - chat dialog (draft).md`
- `008.03.00.prompt - task dialog (draft).md`
- `008.04.00.prompt - user response dialog (draft).md`
- `008.07.00.prompt - add new FAB and role menu (draft).md`
- `009.02.00.prompt - accessibility audit and remediation (draft).md`
