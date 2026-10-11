# ADR-035: AG Grid Community for the Records Spreadsheet

**Status:** Implemented (2026-10-11) — delivered by 001.03 (phase 04)

## Context

Agents keep structured records (orders, customers, stock) in per-company tables ([tcp-mcp-records](../tcp-mcp-records.md)). 001.03 lets people check and correct those records in the web client, in a spreadsheet-like view:

- a header row styled apart from the data;
- sorting and filtering on every column, newest first by default;
- editing in place: click a cell, or move with the arrow keys and press Enter; Enter or clicking away saves;
- a record of the changes made in the session, with undo.

The web client's quality bar is accessibility ([ADR-026](ADR-026-web-ui-accessibility-and-component-library.md), [ADR-027](ADR-027-screen-reader-strategy.md)). An editable grid is one of the hardest widgets to make work with a keyboard and a screen reader, so the prompt asked for a library rather than our own build, chosen with accessibility in mind. Nothing in the client today renders a table or a grid.

## Decision

Use **AG Grid Community** (`ag-grid-community` and `ag-grid-react`, MIT licence) for the editable sheet, and only there.

- **It follows the ARIA grid pattern.** The grid is exposed as `role="grid"` with row, column header and cell roles, `aria-sort` and `aria-colindex`. Its keyboard model is the usual spreadsheet one: arrow keys move between cells; Enter, F2 or typing starts an edit; Enter saves; Escape cancels; Tab moves on. AG Grid tests with JAWS and VoiceOver.
- **Sorting, column filters and typed cell editors are built in**, so the only code we write is the glue to our API.
- **It is set up for screen readers, following AG Grid's own advice.** Rows are paged (100 a page) rather than virtualised, the DOM order matches the visual order (`ensureDomOrder`), and row and column virtualisation are off. Virtualisation means only rendering the rows on screen, and that hides the rest from a screen reader.
- **It is themed from our own CSS custom properties**, so light, dark and high contrast all follow the app's themes.
- **It is loaded only when a sheet opens** (`React.lazy`), so pages without a sheet don't pay for its size — see [why](#bundle-size).
- **Undo is ours, not AG Grid's.** AG Grid's built-in undo covers cell edits only. We also need to undo adding and deleting rows, so the sheet keeps one small stack of inverse API calls.
- Everything around the sheet (its title bar, buttons, menus, dialogs and the table list) stays React Aria, as ADR-026 requires.

## Alternatives considered

| Option                                  | Licence and health                            | Accessibility                                                   | Edit, sort, filter                     | Why not                                               |
| --------------------------------------- | --------------------------------------------- | --------------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------- |
| **AG Grid Community** (chosen)          | MIT; ~2.7M downloads a week; monthly releases | ARIA grid, tested with JAWS and VoiceOver                       | All built in                           | Large, and not React Aria                             |
| React Aria `Table` with our own editing | Already installed                             | The best: React Aria's focus handling                           | Sorting only                           | We would write editing, filtering and undo ourselves  |
| react-data-grid                         | MIT; no dependencies                          | ARIA grid                                                       | Editing and sorting; no filter or undo | Has been in a 7.0 beta for years (beta.61 in 2026)    |
| TanStack Table                          | MIT                                           | Headless (no markup), so all of it would be ours                | Logic only                             | Rolling our own                                       |
| Glide Data Grid                         | MIT                                           | Draws on a `<canvas>`, which screen readers can't read directly | Yes                                    | Accessibility                                         |
| Handsontable                            | Free only for non-commercial use              | Good                                                            | Yes                                    | Licence                                               |
| MUI X Data Grid                         | MIT                                           | Good                                                            | Yes                                    | Brings in MUI and Emotion, a second component library |

React Aria `Table` was the closest call: it is already installed and has the strongest accessibility. But editing, filtering and undo are most of the work, and getting the keyboard and screen-reader behaviour of editing right is exactly what the prompt asked us not to build ourselves.

## Consequences

- One part of the UI doesn't come from React Aria. Its focus handling, popups and keyboard model are AG Grid's, so the browser tier and a manual screen-reader pass have to cover it, not just the unit tests.
- AG Grid's own popups (column filter menus) must be told to render inside the office view's full-screen container (`popupParent`), as React Aria overlays already are.
- AG Grid's keyboard model has to be described to screen-reader users. The sheet links visually hidden usage notes with `aria-describedby`.
- Large tables are paged rather than scrolled. That suits screen readers, but it is less like a desktop spreadsheet.
- Enterprise-only features (copy and paste of ranges, fill handle, set filters) aren't available. Nothing in 001.03 needs them.
- AG Grid releases often. Majors are bumped deliberately, with the browser tier as the check.

## Detail

### Bundle size

`ag-grid-community` 36.2's full minified build is about 1.3 MB before compression. The sheet registers only the modules it uses (client-side rows, text, number and select editors, text, number and date filters, pagination, cell styles), and the whole sheet is a separate lazily loaded chunk. 001.03 records the chunk's size in its plan outcome.

### Grid options this decision relies on

| Option                                                      | Why                                                          |
| ----------------------------------------------------------- | ------------------------------------------------------------ |
| `pagination`, `paginationPageSize: 100`                     | Paging instead of virtualised scrolling, for screen readers  |
| `ensureDomOrder`                                            | DOM order matches the visual order                           |
| `suppressRowVirtualisation`, `suppressColumnVirtualisation` | Every row on the page and every column is in the DOM         |
| `stopEditingWhenCellsLoseFocus`                             | Clicking away saves, as the prompt asks                      |
| `popupParent`                                               | Filter menus stay inside full screen                         |
| `theme: themeQuartz.withParams(...)`                        | Colours and fonts come from the app's CSS custom properties  |
| `undoRedoCellEditing: false`                                | Our own undo stack covers edits, added rows and deleted rows |

## Amendment as implemented (001.03, phase 04) <a id="amendment-as-implemented-p04-001-03"></a>

[001.03](../prompts/phase%2004%20-%20utility/001.03.01.plan%20-%20records%20view%2C%20edit%20and%20csv%20export%20in%20the%20web%20ui.md) built the sheet as decided. These are the facts the build added.

- **Bundle size.** The lazy `RecordSheet` chunk is 971 kB (272 kB gzipped). The main bundle grew by 18 kB, for the views around the sheet.
- **AG Grid's own text is English only.** Its filter menus and pagination ("Page 1 of 1") come from its English locale, not from `t()`. They can be routed through `localeText` when translation work starts (logged in [outstanding-issues.md](../outstanding-issues.md#ag-grid-ui-strings-bypass-t)).
- **Rows never move when edited.** The default "Updated, newest first" sort compares each row's position in the cached table, which edits patch in place, not its timestamp. A sort the user picks re-applies as values change. This follows [ADR-027](ADR-027-screen-reader-strategy.md): a row must not jump away from the cursor.
- **Ctrl/Cmd+Z undoes our stack only when no cell is being edited.** While an editor is open, the key belongs to the editor.
- **`singleClickEdit` is on**, as the prompt asked. A click starts an edit, as well as Enter, F2 or typing.
- **Cells edit as text, number or a true/false list.** Dates are text; the server checks their format.
- **A browser-tier test and component tests cover it.** AG Grid renders and edits under jsdom, so Vitest covers editing, undo, add, delete and append. `test/browser/records.spec.ts` covers the keyboard-only edit, sorting, and axe on the tray, dialog and tab. The manual screen-reader pass is still to do (see [outstanding-issues.md](../outstanding-issues.md#record-sheet-screen-reader-pass-is-not-done)).
