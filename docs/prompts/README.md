# Prompts

This is an archive of initial prompts and plans - created in planning mode, documenting the high-level process of each piece of work initiated.

It's worth noting that the tests regularly evolved by conversation with the coding assistant, and that a lot of smaller pieces of work were conducted after each large plan has been executed - either bug fixing, code quality improvements, or modifications to code behaviour and scripts.

## Structure

Prompts are grouped into phase directories, each with its own numbering starting at `001.01.00`:

- `phase 01 - service/` - the core service build-out (tcp-server, tcp-agent, MCP servers, shared library).
- `phase 02 - web ui/` - the web UI MVP (tcp-frontend: shell, sign-in, live activity lists, dialogs).
- `phase 03 - web visualisation/` - the isometric office view and the UI work around it.
- `phase 04 - service quality/` - future-work items for the service (security/ethics review, configurable third-party services, accessibility, Strands and meshLLM evaluation), plus `unplanned.md` for notes not yet turned into prompts.
- `phase 05 - web ui quality/` - future-work items for the web UI (browser test suite, accessibility audit, reduced motion, documentation close-out, build flags, company configuration view).

## Numbering

Every document is numbered `xxx.yy.zz.prompt` or `xxx.yy.zz.plan` (e.g. `001.01.00.prompt - initial planning and ADRs.md`), so both its place in the history and its kind are visible right after the number:

- `xxx` - the major theme (kept from the original numbering).
- `yy` - a sub-theme, related topic, or side-mission within that theme. A single user prompt that spawns several plans (e.g. a "combination prompt" broken into ordered sub-plans) keeps one `yy` for the whole thread, even where the individual parts cover different components.
- `zz` - chronological order within that `yy` bucket - prompts, plans, feedback, and fixes all share the same sequence, in the order they were written.
- `.prompt` - a user-authored ask, question, or piece of feedback.
- `.plan` - an implementation plan or other assistant-authored planning artefact.

Where a prompt has no companion plan, it's very likely because the work was small enough to implement directly; those files carry a note near the top saying so. Draft prompts in `phase 04` and `phase 05` are the exception - they're future work that hasn't been picked up yet, not work implemented without a plan, so they carry no such note.
