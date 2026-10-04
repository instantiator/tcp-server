# ADR-026: Accessibility Standards, Component Library and Auditing

**Status:** Accepted (amended — see [008.01](#amendment-as-implemented-00801) at the end)

## Context

The MVP ships deliberately unstyled ([ADR-020](ADR-020-web-ui-mvp-scope.md)). With visual design deferred, **accessibility is the quality bar** — it's what "finished" means for this release, rather than something added afterwards.

That inverts the usual way a component library is chosen. How it looks, and how quickly it can be themed, barely matter here. What matters is the quality of the keyboard handling, focus management and screen reader semantics underneath, and whether it stays out of the way of a CSS layer written later.

## What needs deciding

1. **What standard we're aiming at**, and how it's measured.
2. **Which component library** provides the behaviour.
3. **How themes work**, given the MVP ships with empty stylesheets.

The application has genuinely hard accessibility surfaces: four lists updating live, a transcript that streams in word by word, and stacked dialogs. How those _behave_ is [ADR-027](ADR-027-screen-reader-strategy.md); this ADR sets the standard and picks the tools.

## Options considered

### Target standard

WCAG[^wcag] 2.2 AA is the near-universal baseline, and the level most legal and procurement regimes reference. Full AAA isn't a realistic project-wide target — it includes requirements (sign language for prerecorded audio, a reading-level constraint) that either don't apply or would distort the product.

The useful question is which AAA criteria to adopt selectively.

[^wcag]: Web Content Accessibility Guidelines — the international standard, with three levels: A (minimum), AA (the usual legal target), AAA (strictest).

### Component library

|                                      | **React Aria Components**                                             | Radix UI              | MUI                                             | Base UI                      |
| ------------------------------------ | --------------------------------------------------------------------- | --------------------- | ----------------------------------------------- | ---------------------------- |
| Version / licence                    | 1.19.0, Apache-2.0, 2026-06                                           | 1.1.23, MIT, 2026-07  | 9.2.0, MIT, 2026-07                             | 1.0.0-**rc.0**, MIT, 2025-12 |
| Styling                              | None — behaviour only                                                 | None — behaviour only | Full design system + Emotion runtime            | None                         |
| Accessibility rigour                 | Adobe's; tested across real screen reader / browser / OS combinations | Very good             | Good, but bundled with appearance               | Promising                    |
| Live announcer[^announcer]           | **Built in**                                                          | Not provided          | Not provided                                    | Not provided                 |
| Fit for "unstyled now, themed later" | Exact                                                                 | Exact                 | Poor — appearance must be overridden, not added | Exact                        |
| Maturity                             | Stable                                                                | Stable                | Stable                                          | Release candidate            |

Tailwind isn't a candidate: it supplies utility classes, not component semantics. It could sit alongside a headless[^headless] library, but it can't answer the question this ADR asks.

[^announcer]: The piece that speaks a message to a screen reader when something changes on screen without the user doing anything. ADR-027 depends heavily on it.

[^headless]: A "headless" library provides behaviour — keyboard handling, focus, ARIA roles — with no appearance at all, leaving styling entirely to the consumer.

## Decision

**WCAG 2.2 AA as the project target, with three AAA criteria adopted. React Aria Components for behaviour. CSS custom properties for theming. Automated accessibility checks in both test tiers.**

React Aria Components wins on the two criteria that matter: its accessibility work is tested against real assistive technology rather than against the spec alone, and — decisively — it ships a **live announcer**, which is the single hardest primitive ADR-027 needs and the one thing no other candidate provides.

- [Three AAA criteria](#the-three-aaa-criteria-adopted) are adopted above AA; three others are explicitly not.
- [Themes are CSS custom properties](#how-themes-work), and component stylesheets never contain literal values.
- [Auditing is layered](#how-conformance-is-checked), and the manual layer is named — automated tools can't check whether an announcement is _useful_.

## Consequences

- React Aria Components becomes a production dependency. Apache-2.0, compatible with the repo's MIT licence, and it appears in the generated `docs/licenses.md`.
- **Its components are unstyled to the point of being invisible** — no focus ring, no borders — until the CSS layer exists. The MVP therefore needs a minimal base stylesheet from day one, or early screens can't be reviewed by sighted testers. This is a real cost of choosing headless.
- Automated accessibility assertions in every component test slow the suite. Accepted — the alternative is finding violations in a manual pass at the end of the phase.
- The empty-stylesheet convention only holds if review enforces it. A literal colour in a component stylesheet is invisible to linting and breaks theming silently.
- Adopting the "no timing" criterion rules out toasts that vanish on their own as the only notice of an event ([ADR-027](ADR-027-screen-reader-strategy.md) specifies the pattern).
- The manual screen reader matrix needs macOS **and** Windows. That's a real cross-platform testing obligation, and the honest reason many projects skip it.
- The chosen theme has to be readable before the page first paints, or it flashes the wrong theme. That means a tiny inline script in the page head, ahead of the bundle.

## Alternatives considered

- **MUI.** The fastest route to something that looks finished — and wrong for a release that's deliberately unfinished-looking. Its accessibility is good but inseparable from its appearance, so we'd be overriding rather than adding.
- **Radix UI.** A genuinely close second: MIT rather than Apache-2.0, smaller, excellent semantics. It loses on the live announcer and on breadth of assistive-technology testing. Nothing would be wrong with Radix; the tiebreak is ADR-027's requirements.
- **Base UI.** From the MUI team, headless, well-designed — still at `1.0.0-rc.0`. Rejected on maturity alone; worth revisiting later.
- **No library — hand-written components.** Tempting for an unstyled MVP, since a `<button>` is a `<button>`. Rejected on the dialogs: focus trapping, scroll locking, stacked-dialog semantics and the minimise-to-bar pattern are exactly where hand-rolled implementations fail, and they're central to this UI.
- **AA only, no AAA criteria.** Simpler to state. Rejected because the high-contrast theme is already an MVP requirement, so the enhanced-contrast criterion is being met anyway — naming it costs nothing and makes it testable.

## Prompts to update when this is decided

- `002.01.00.prompt - application infrastructure.md`
- `002.02.00.prompt - testing infrastructure (draft).md`
- `003.01.00.prompt - landing page (draft).md`
- `003.02.00.prompt - application shell, routing and header (draft).md`
- `003.03.00.prompt - shared ui states, notifications and accessibility primitives (draft).md`
- `008.01.00` – `008.06.00` (all dialog prompts)
- `phase 03 - web visualisation/003.01.00.prompt - add new FAB and role menu.md`
- `phase 06 - web ui quality/001.02.00.prompt - accessibility audit and remediation (draft).md`

## Detail

### The three AAA criteria adopted

Adopted above AA, because they're cheap in an unstyled application and directly serve the users this product has:

- **1.4.6 Contrast (Enhanced), 7:1** — the high-contrast theme's reason to exist. The default theme targets AA (4.5:1); high-contrast targets AAA.
- **2.4.8 Location** — the breadcrumb is already in the MVP, so meeting this is essentially free.
- **2.2.3 No Timing** — no session countdowns, and no content that conveys information and then disappears on its own. Toasts that vanish lose information; they persist until dismissed, or are duplicated somewhere durable.

Explicitly **not** adopted:

- 1.4.9 (images of text) — doesn't apply
- 3.1.5 (reading level) — doesn't apply
- 2.4.9 (link purpose from link text alone) — conflicts with compact list rows

### How themes work

Two themes ship, each with light and dark modes:

- **default** — soft colours, AA contrast
- **high-contrast** — few colours, used functionally for edges, boxes and focus; AAA contrast

Component CSS files ship with meaningful class names and **empty rule bodies**, to be filled per theme later. Every colour, spacing and border value resolves through a CSS custom property; no component stylesheet contains a literal value.

Theme selection is an explicit user choice. It's initialised from the browser's `prefers-color-scheme` and `prefers-contrast` settings and then persisted — the system settings seed the default, they don't override the user.

`prefers-reduced-motion` is honoured from the start. There's little motion in an unstyled MVP, which is precisely why the convention is cheap to establish now.

### How conformance is checked

| Layer           | Tool                     | Gate                                                 |
| --------------- | ------------------------ | ---------------------------------------------------- |
| Edit time       | `eslint-plugin-jsx-a11y` | Lint error — part of the existing zero-warnings rule |
| Component tests | axe[^axe] via the runner | Every component test asserts no violations           |
| Browser tests   | `@axe-core/playwright`   | Every MVP journey scans its rendered pages           |
| Manual          | Screen reader matrix     | Per release, recorded                                |

Automated tooling catches roughly a third to a half of real barriers, and none of what ADR-027 is about — whether an announcement is _useful_ can't be checked by a machine.

The manual pass is therefore not optional, and needs a named matrix:

- VoiceOver + Safari (macOS)
- NVDA + Firefox (Windows)
- VoiceOver on iOS Safari

Run against the MVP journeys, before release.

[^axe]: An open-source accessibility testing engine that inspects a rendered page and reports violations. It runs inside both component tests and browser tests.

## Amendment as implemented (008.01) <a id="amendment-as-implemented-00801"></a>

The dialog framework and the transcript components ([008.01](../prompts/phase%2002%20-%20web%20ui/008.01.00.prompt%20-%20dialog%20framework%20and%20event%20transcript%20components.md)) are the first real use of React Aria's dialog and this ADR's library choice. Four things worth recording:

- **React Aria's dialog behaved as chosen.** Wrapping `ModalOverlay`/`Modal`/`Dialog` gave the focus trap, the scroll lock, the escape handling and the stacked-dialog behaviour with nothing hand-written. `<Heading slot="title">` is what supplies the dialog's accessible name; a plain `<h2>` would leave it unnamed.
- **The ADR names "the minimise-to-bar pattern" as one of the reasons for choosing a library. As built, minimising unmounts the dialog rather than hiding it**, because a mounted modal keeps its focus trap and keeps the rest of the page inert. So the library supplies the modal, and the dock (`DockProvider`/`useDock`, `src/components/Dialog/`) is ours: about sixty lines.
- **React Aria restores focus after the dialog unmounts, not during it.** A test asserting focus return has to wait for that, or it reads the focus of a moment too early. Both focus-return tests in `Dialog.test.tsx` use `waitFor` for this reason.
- **A modal marks everything outside itself `aria-hidden`**, so a test cannot find the trigger by role while the dialog is open. That is correct behaviour, and worth knowing before it looks like a bug.

## Amendment as implemented (003.01, phase 03) <a id="amendment-as-implemented-p03-003-01"></a>

The "Add new" control ([003.01](../prompts/phase%2003%20-%20web%20visualisation/003.01.00.prompt%20-%20add%20new%20FAB%20and%20role%20menu.md)) was the first control that had to reach past an open dialog. Dialogs are modal, so the page behind one, including this control, is inert. Two ways out were weighed: make the dialogs non-modal, or start new work from inside the dialog.

- **Dialogs stay modal.** Making them non-modal would have meant giving up the library's focus trap, which is one of the reasons this ADR chose a library. The decision above stands unchanged.
- **The chat dialog carries its own "Add new" menu** in its title bar, through a new `actions` slot on `Dialog`. A new chat joins the dialog as another panel. A new task opens as a second modal stacked on top, which React Aria handles with nothing hand-written: Escape closes only the top one.
- **The task dialog has no such menu, by decision.** It holds nothing the user typed, so closing it to reach the page's control loses nothing.
- **Disabling a focused menu item drops focus to the menu itself.** A menu that marks its pending item disabled loses the user's place. The roles submenu disables only the other items and ignores a second press on the pending one.

## Amendment as implemented (005.01, phase 03) <a id="amendment-as-implemented-p03-005-01"></a>

[005.01](../prompts/phase%2003%20-%20web%20visualisation/005.01.00.prompt%20-%20ui%20improvements.md) was a visual pass: a sticky header, company cards, one tab per activity list, and an office view whose controls float over the canvas. It added the first shared presentation classes, and changed nothing about the decisions above.

- **Shared classes, beside the empty-rule-body convention.** `base.css` now ends with `.tcp-icon-button`, `.tcp-badge`, `.tcp-card` and `.tcp-floating`: the start of a design system. Component stylesheets still carry class names only, except where a page's own layout has no shared class to use (the company card row, the office view's overlays).
- **Icon-only controls are named twice, the same way.** Every round icon button (Account, Add new, Show details for…, Close details, Follow, pan, full screen) has an `aria-label` and a tooltip with the same words, through `WithTooltip` in `components/Icon/Icon.tsx` (WCAG 2.5.3). Sizes come from tokens that clear the 24px target minimum; the floating "Add new" clears 44px.
- **A highlight colour joined both themes** (`--tcp-color-highlight` and its text colour), at 4.5:1 in the default theme and 7:1 in high contrast, for the tabs' count badges.
- **Only CSS moved the office view's controls.** Their DOM order, and so the tab order, is unchanged. The new slides (tray, "Add new") are CSS transitions, which the existing reduced-motion rule already cancels.
