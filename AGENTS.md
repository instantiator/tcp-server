<!-- dev-qual:start -->

# Agent instructions

These rules are mandatory and override your defaults. `dev-qual/` is in this repo (or clone <https://github.com/instantiator/dev-qual> to a temporary location once per session).

## Non-negotiable rules

1. Less is more: concise, readable code and simple interfaces. No unrequested abstractions.
2. Comments state intent, not mechanics. Comment classes, functions, and consts; skip trivial ones.
3. Zero compiler errors and warnings; zero linter errors and warnings.
4. Never cast to `any` (or equivalent type escapes), especially in test mocks.
5. Never store secrets in the code base.
6. Only change code you have been asked to change; ask permission otherwise.

## Process

- Before starting work: run `dev-qual/scripts/check-updates.sh`; if it reports an update, offer to run `dev-qual/scripts/upgrade.sh` first.
- Planning is collaborative: present options and trade-offs before committing to libraries, approaches, data structures, or key business logic. Plan with the `plan-work` skill (`dev-qual/skills/plan-work/SKILL.md`).
- Before coding: read `dev-qual/guidance/process/before-coding.md`.
- Route via `dev-qual/guidance/index.md`: lazy-load only the docs relevant to the task, following references recursively when needed.
- For multi-step tasks (setup, review, deploy, audit): use the matching skill from `dev-qual/skills/index.md`.
- After every change: run `dev-qual/scripts/check.sh` and fix what it reports.
- When done: apply the judgment items in `dev-qual/guidance/process/after-coding.md` — tests for intent and edge cases, simplification, comment accuracy, documentation updates.
- Anything left undone goes in `docs/outstanding-issues.md` with a measurable condition for when to act on it, and into your summary to the user.
- Sub-agents and a choice of model available? Allocate work by capability and cost first: `dev-qual/guidance/process/model-allocation.md`.

## Assurance

- State the filename of any guidance doc you read, so the user can see you are following it.

<!-- dev-qual:end -->
