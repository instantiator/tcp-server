# ADR-027: Screen Reader Strategy for Live and Data-Rich Views

**Status:** Accepted (2026-08-03)

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

### Testing the announcement behaviour

Everything above is a behaviour, not a structure — axe ([ADR-026](ADR-026-web-ui-accessibility-and-component-library.md)) checks roles and labels, not whether the right words were announced at the right time.

| Option                                                                  | Notes                                                                                                                                                                                                                                 |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Assert on the live region directly** _(chosen)_                       | Free — the existing Vitest/Testing Library component tier ([ADR-028](ADR-028-frontend-testing-strategy.md)), with fake timers advanced past the throttle interval. Checks the right text landed in the right place at the right time  |
| **`@guidepup/virtual-screen-reader`** _(chosen)_                        | A screen reader simulator that runs against jsdom — no browser, no OS screen reader. Reports what would actually be spoken, not just what's in the DOM. See [Detail](#automated-tests-for-announcement-behaviour)                     |
| Real screen reader automation (`@guidepup/playwright` + VoiceOver/NVDA) | The closest to ground truth — and it needs a macOS runner for VoiceOver and a Windows runner for NVDA, the same cost ADR-026 already named as the reason its manual matrix only runs per release. Documented as optional, not adopted |
| Status quo (axe only)                                                   | Catches structural accessibility issues. Catches nothing about announcement timing, coalescing, or the per-token-noise failure mode this ADR exists to prevent                                                                        |

## Decision

**Expose everything for browsing; curate what gets announced. These are two different channels, not two settings of one.**

So: **option A for exposure, option B for announcement.**

- **The page is fully navigable.** Nothing is hidden from the screen reader's virtual cursor. Screen reader users explore by browsing, and suppressing content to "simplify" removes the very thing they navigate with.
- **Announcements are separate and curated.** A [live region](#one-announcer-not-scattered-live-regions) carries a small number of useful, coalesced statements — not a running commentary on every change.

The policy is applied per surface — see the [per-surface policy table](#per-surface-policy).

1. **Never announce a partial response.** Words render on screen as they arrive; the announcement happens once, when the response is complete.
2. **[Combine and throttle](#coalescing-and-throttling) per region.** Multiple changes in one region become a single announcement, sent at most once per interval. Under a burst, the user hears one sentence, not six.
3. **Announce what changed, not the new state.** "Tasks: 2 added" is useful; re-reading the whole list is not.

Two supporting decisions: [focus is managed at exactly four points](#focus-is-managed-at-four-points), and [live updates never reorder what's under the cursor](#live-updates-never-reorder-the-list).

**The coalescing and throttling rules above are an automated test gate, not just a description.** Every announcer behaviour — the "never word by word" rule, the per-region throttle, the "what changed" wording — gets a Vitest test using `@guidepup/virtual-screen-reader` alongside plain Testing Library assertions on the live region. See [Detail](#automated-tests-for-announcement-behaviour).

## Consequences

- The announcer is application infrastructure and must exist before the first live surface. Retrofitted, every component that grew its own live region needs unpicking.
- Throttle intervals are guesses until tested with a real screen reader. They're configurable constants, and the manual pass tunes them.
- Coalescing means announcements lag reality by up to the interval. That's correct — the visual view is live, and the audio channel summarises it.
- **A completed response can be long.** An agent's answer may run to several paragraphs, and announcing all of it is disruptive in a different way. The implementation should consider announcing only that a response arrived, leaving the content to be browsed. Flagged as **unresolved** until the manual pass — it needs real listening to judge.
- Stable list ordering conflicts with "most recently active first", which is the obvious visual design. Stability wins; recency ordering would need an explicit control rather than automatic reordering.
- A toast is never the only notice of an event — the underlying list must also reflect it (following ADR-026's "no timing" criterion).
- **The coalescing/throttling behaviour now has an automated gate** ([Detail](#automated-tests-for-announcement-behaviour)), so a regression that announces per-token noise or drops the throttle fails the build, not just a manual pass. What the gate still can't check is _phrasing quality_ — whether "Tasks: 2 added" is actually the most useful wording. That judgement stays with ADR-026's manual matrix.
- `@guidepup/virtual-screen-reader` is a new dev dependency, MIT-licensed, jsdom-based — no OS screen reader or extra CI runner needed. Its docs are written against Jest; since ADR-028 chose Vitest, confirming it works under Vitest's jsdom environment is a short spike before it's relied on, not an assumption.

## Alternatives considered

- **Expose everything, announce everything.** The naive reading of "let the screen reader read it as it sees fit". Rejected: with word-by-word streaming it produces continuous interruption, and the screen reader has no way to know which of a hundred changes mattered.
- **Suppress the view, announce only summaries.** The opposite approach. Rejected because it removes browsing — a user who hears "3 tasks running" and then can't explore those tasks has less access than before. Suppression also hides content from other assistive technology that relies on the same information.
- **A live region per component.** The path of least resistance during implementation, and the reason live-region output is so often unusable. Rejected in favour of one announcer — see [Detail](#one-announcer-not-scattered-live-regions).
- **A user-configurable verbosity setting.** Genuinely useful, and deferred: it assumes a sensible default to vary from, which is what this ADR establishes. Worth revisiting once the manual pass has tuned the defaults.
- **Real screen reader automation in CI** (`@guidepup/playwright` driving VoiceOver/NVDA). The most faithful test available, and rejected as a required gate on cost, not capability: it needs a macOS runner and a Windows runner specifically for this, on top of whatever the rest of CI already runs on. Left as a documented, optional upgrade — see [Detail](#automated-tests-for-announcement-behaviour).

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

### Automated tests for announcement behaviour

Two layers, both in the Vitest/Testing Library component tier ([ADR-028](ADR-028-frontend-testing-strategy.md)), neither needing a browser or a real screen reader.

**Layer 1 — assert on the live region's DOM node.** Render the announcer, dispatch mock `WireEvent`s, advance fake timers past the throttle interval, and assert the live region's `textContent` (`@testing-library/jest-dom`'s `toHaveTextContent`). This alone catches "the wrong text landed" or "it fired before the throttle interval elapsed."

**Layer 2 — `@guidepup/virtual-screen-reader`.** A screen reader simulator, not a DOM inspector: it runs against jsdom, and reports what would actually be _spoken_, in order.

```ts
import { virtual } from '@guidepup/virtual-screen-reader';

await virtual.start({ container: document.body });
// ...dispatch WireEvents, advance fake timers past the throttle interval...
expect(virtual.spokenPhraseLog()).toEqual(['Tasks: 2 added, 1 completed']);
```

`spokenPhraseLog()` is the assertion that matters: it's the ordered sequence of everything the simulator would announce. A test asserting the log contains exactly one coalesced phrase — and does **not** contain a hundred per-token entries — directly encodes the one rule this ADR exists to enforce. `lastSpokenPhrase()` covers the simpler single-announcement cases (dialog labelling, error alerts).

MIT-licensed, actively maintained, and — being DOM-based rather than tied to a specific test runner — should port from its Jest-oriented docs to Vitest without needing Jest itself. Confirm that in a short spike before relying on it; don't assume it.

**What this doesn't replace.** Neither layer judges whether the announced text is _good_ — clear, appropriately brief, correctly prioritised. That's a human judgement, and stays with ADR-026's manual screen reader matrix. These two layers close the "silently regressed" gap; they don't close the "is it well-designed" one.

**The real-screen-reader option, if it's ever adopted.** `@guidepup/playwright` drives actual VoiceOver (macOS) and NVDA (Windows) from Playwright, and would sit in the browser tier's six journeys rather than the component tier. Not adopted now — see [Alternatives considered](#alternatives-considered) for the CI-cost reasoning — but it can be added later without touching Layers 1–2.

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

Moving focus anywhere else — including "helpfully" onto newly arrived content — pulls a screen reader user away, without warning, from whatever they were reading.

### Live updates never reorder the list

A list that re-sorts as items change status moves content out from under someone mid-read.

Lists keep a stable sort: new items append, and status changes update in place.
