# TCP Server

NestJS monorepo for the TCP simulation: `tcp-server` (REST API + orchestration), `tcp-agent` (agent loop runner), three MCP servers, and a shared library (`libs/tcp-shared`, imported as `@tcp/shared`).

## Mandatory instructions

Follow `AGENTS.md` in this repo — it contains the dev-environment rules (mandatory, overriding defaults) and the skills routing table. Route to further guidance via `dev-environment/guidance/index.md`, loading only what the task needs.

## Project knowledge (lazy-load as needed)

- `docs/development.md` — tech stack, source layout, everyday commands, key conventions. Read before coding.
- `docs/index.md` — all documentation, including ADRs with implementation status.
- Generated artefacts (`schemas/schema.json`, `docs/licenses.md`) are never edited by hand — regenerate via `npm run build`.

## Claude Code specifics

- Skills are installed at `.claude/skills/` — prefer invoking them over improvising the same workflow.
- **Sub-agents are granted standing, without asking each time.** Phase prompts allocate work across models (`docs/prompts/*/model-allocation.md`), so delegating a step is the working method here, not an escalation. The allocation rules still apply: a delegated step needs its files, decisions, done-condition and boundary written out first, and Opus keeps security, authorisation, accessibility, concurrency and lifecycle work.
- Git hooks run the quality gate: pre-commit runs `check.sh --fast`, pre-push runs the full gate plus schema/licence/migration drift checks. A failing hook means fix the reported problems — never `--no-verify`.
- After every change, run `./dev-environment/scripts/check.sh` and fix what it reports.

<!-- dev-qual:start -->

# Claude Code instructions

Follow `dev-qual/agents-files/remote/AGENTS.md` — those rules are mandatory. If this project has its own AGENTS.md merged from it, that copy governs.

## Claude Code specifics

- Skills from `dev-qual/skills/` may be installed at `.claude/skills/` (or `~/.claude/skills/`) — prefer invoking them over improvising the same workflow.
- If dev-qual's hooks are in `settings.json` (they call `dev-qual/scripts/agent-hook.sh`), `check.sh --fast` runs after every edit and its failures are shown to you: fix them, and don't re-run it redundantly. Otherwise run `dev-qual/scripts/check.sh` yourself after every change.
- Session-start output from dev-qual is actionable: offer the update or git hooks it names, and act on the user's answer.
- A dev-qual stop-hook block lists failing checks or unticked plan stages: fix them, or tell the user why they remain.
- Git hooks installed by `dev-qual/scripts/setup-hooks.sh` are the final gate: a failing pre-commit means fix the reported problems, never `--no-verify`.
- Mirror deferred work into memory with the same measurable condition it has in `docs/outstanding-issues.md` — the file is still the record, memory is only a reminder.

<!-- dev-qual:end -->
