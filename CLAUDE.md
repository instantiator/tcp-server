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
- Git hooks run the quality gate: pre-commit runs `check.sh --fast`, pre-push runs the full gate plus schema/licence/migration drift checks. A failing hook means fix the reported problems — never `--no-verify`.
- After every change, run `./dev-environment/scripts/check.sh` and fix what it reports.
