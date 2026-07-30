# ADR-026: Accessibility Standards, Component Library and Auditing

**Status:** Proposed (2026-07-30)

## Context

The MVP ships deliberately unstyled ([ADR-020](ADR-020-web-ui-mvp-scope.md)).
With visual design deferred, **accessibility is the quality bar** — it is what
"finished" means for this release rather than something added afterwards.

That inverts the usual component-library evaluation. The normal criteria — how
it looks, how fast it is to theme — are close to irrelevant here, because the
MVP wants no opinions about appearance at all. What matters is the quality of
the keyboard interaction, focus management and ARIA semantics underneath, and
whether the library gets out of the way of a CSS layer written later.

The application also has genuinely hard accessibility surfaces: four lists
updating live, a token-by-token streaming transcript, and stacked dialogs. Those
are handled in [ADR-027](ADR-027-screen-reader-strategy.md); this ADR sets the
standard, picks the library and defines how conformance is checked.

## Options considered

### Target standard

WCAG 2.2 AA is the near-universal baseline and the level most procurement and
legal regimes reference. Full AAA is not a realistic project-wide target — it
includes requirements (sign language for prerecorded audio, a reading level
constraint) that do not apply or would distort the product. The useful question
is which AAA criteria to adopt selectively.

### Component library

|                                      | **React Aria Components**                                                          | Radix UI              | MUI                                             | Base UI                      |
| ------------------------------------ | ---------------------------------------------------------------------------------- | --------------------- | ----------------------------------------------- | ---------------------------- |
| Version / license                    | 1.19.0, Apache-2.0, 2026-06                                                        | 1.1.23, MIT, 2026-07  | 9.2.0, MIT, 2026-07                             | 1.0.0-**rc.0**, MIT, 2025-12 |
| Styling                              | None — behaviour only                                                              | None — behaviour only | Full design system + Emotion runtime            | None                         |
| A11y rigour                          | Adobe's; tested across real AT/browser/OS combinations, the most thorough of these | Very good             | Good, but bundled with appearance               | Promising                    |
| Live announcer                       | **Built in** (`@react-aria/live-announcer`)                                        | Not provided          | Not provided                                    | Not provided                 |
| Fit for "unstyled now, themed later" | Exact                                                                              | Exact                 | Poor — appearance must be overridden, not added | Exact                        |
| Maturity                             | Stable                                                                             | Stable                | Stable                                          | Release candidate            |

Tailwind is not a candidate: it supplies utility classes, not component
semantics. It could sit alongside a headless library, but it cannot answer the
question this ADR asks.

## Decision

**WCAG 2.2 AA as the project target, with selected AAA criteria; React Aria
Components as the behaviour layer; CSS custom properties for theming; axe in
both automated test tiers.**

### AA everywhere, with three AAA criteria adopted

Adopted above AA, because they are cheap in an unstyled application and directly
serve the users this product has:

- **1.4.6 Contrast (Enhanced), 7:1** — the high-contrast theme's reason to
  exist. The default theme targets AA (4.5:1); high-contrast targets AAA.
- **2.4.8 Location** — the breadcrumb is already in the MVP; meeting the
  criterion is essentially free.
- **2.2.3 No Timing** — no session countdowns or auto-dismissing content that
  conveys information. Toasts that vanish are an information-loss pattern; they
  persist until dismissed or are duplicated somewhere durable.

Explicitly **not** adopted: 1.4.9 (images of text), 3.1.5 (reading level), 2.4.9
(link purpose from link text alone) — the first two do not apply, the third
conflicts with compact list rows.

### React Aria Components for behaviour, no styling library

It wins on the two criteria that matter here. Its accessibility work is tested
against real assistive technology across platforms rather than against the spec
alone, and — decisively for this application — it ships a **live announcer**,
which is the single hardest primitive ADR-027 needs and the one thing no other
candidate provides.

MUI is rejected for the reason that would normally recommend it: it brings a
complete visual design system and an Emotion runtime. In an application whose
first release is intentionally unstyled and whose themes are CSS files with
empty rule bodies, that is work to override rather than work saved.

Radix is a genuinely close second — MIT rather than Apache-2.0, smaller,
excellent semantics. It loses on the announcer and on breadth of AT testing.
Nothing here would be wrong with Radix; the tiebreak is ADR-027's requirements.

### Themes are CSS custom properties, and components never hardcode values

Two themes ship, each with light and dark modes:

- **default** — soft colours, AA contrast
- **high-contrast** — few colours used functionally (edges, boxes, focus), AAA
  contrast

Component CSS files ship with meaningful class names and **empty rule bodies**,
to be filled per theme later. Every colour, spacing and border value resolves
through a custom property; no component stylesheet contains a literal. Theme
selection is an explicit user choice, initialised from `prefers-color-scheme`
and `prefers-contrast` and then persisted — the media queries seed the default,
they do not override the user.

`prefers-reduced-motion` is honoured from the start. There is little motion in
an unstyled MVP, which is precisely why the convention is cheap to establish now.

### Auditing is layered, and the manual layer is named

| Layer           | Tool                      | Gate                                                 |
| --------------- | ------------------------- | ---------------------------------------------------- |
| Edit time       | `eslint-plugin-jsx-a11y`  | Lint error — part of the existing zero-warnings rule |
| Component tests | axe via the chosen runner | Every component test asserts no violations           |
| Browser tests   | `@axe-core/playwright`    | Every MVP journey scans its rendered pages           |
| Manual          | Screen reader matrix      | Per release, recorded                                |

Automated tooling catches roughly a third to a half of real barriers, and none
of what ADR-027 is about — whether an announcement is _useful_ is not
machine-checkable. The manual pass is therefore not optional and needs a named
matrix: VoiceOver + Safari (macOS), NVDA + Firefox (Windows), and VoiceOver on
iOS Safari, run against the MVP journeys before release.

## Consequences

- React Aria Components is a production dependency. Apache-2.0, compatible with
  the repo's MIT licence, and it appears in the generated `docs/licenses.md`.
- Its components are unstyled to the point of being invisible — no focus ring,
  no borders — until the CSS layer exists. The MVP therefore needs a minimal
  base stylesheet from day one, or early screens will be untestable by sighted
  reviewers. This is a real cost of choosing headless.
- Axe assertions in every component test slow the suite. Accepted; the
  alternative is discovering violations in a manual pass at the end of the phase.
- The empty-rule-body convention only holds if it is enforced by review. A
  literal colour in a component stylesheet is invisible to lint and breaks
  theming silently.
- Adopting 2.2.3 rules out auto-dismissing toasts as the sole channel for an
  event ([ADR-027](ADR-027-screen-reader-strategy.md) specifies the pattern).
- The screen reader matrix needs macOS **and** Windows. That is a real
  cross-platform testing obligation, and the honest reason many projects skip
  the manual pass.
- Theme choice must be readable before first paint or the page flashes the wrong
  theme. A tiny inline script in the document head, ahead of the bundle.

## Alternatives considered

- **MUI.** Fastest route to something that looks finished, and wrong for a
  release that is deliberately unfinished-looking. Its accessibility is good but
  inseparable from its appearance.
- **Radix UI.** Close second; rejected only on the live announcer and AT-testing
  breadth. The obvious substitute if React Aria's API proves heavy.
- **Base UI.** From the MUI team, headless, well-designed — still at
  `1.0.0-rc.0`. Rejected on maturity alone; worth revisiting later.
- **No library — hand-written components with ARIA.** Tempting for an unstyled
  MVP, since a `<button>` is a `<button>`. Rejected on the dialogs: focus
  trapping, scroll locking, stacked-dialog semantics and the minimise-to-bar
  pattern are exactly where hand-rolled implementations fail, and they are
  central to this UI.
- **AA only, no AAA criteria.** Simpler to state. Rejected because the
  high-contrast theme is already an MVP requirement, so 1.4.6 is being met
  regardless — naming it costs nothing and makes it testable.

## Prompts to update when this is decided

- `002.01.00.prompt - application infrastructure (draft).md`
- `002.02.00.prompt - testing infrastructure (draft).md`
- `003.01.00.prompt - landing page (draft).md`
- `003.02.00.prompt - application shell, routing and header (draft).md`
- `003.03.00.prompt - shared ui states, notifications and accessibility primitives (draft).md`
- `008.01.00` – `008.07.00` (all dialog prompts)
- `009.02.00.prompt - accessibility audit and remediation (draft).md`
