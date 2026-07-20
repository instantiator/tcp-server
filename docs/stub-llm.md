# lcp-stub-llm

`apps/lcp-stub-llm` is a configurable stub LLM server used by this suite's
integration/e2e tests (and available for manual testing) in place of a real
model. It answers `POST /v1/chat/completions` with pre-scripted text and tool
calls instead of running an actual model, so a test can deterministically
drive an agent through a whole conversation or task without any real LLM.

It is a **standalone application**: its own `package.json`, `tsconfig.json`,
lint config, and tests, sharing no code with any other app in this repo. That
is deliberate — it is generally useful for testing any LLM/agentic system,
not just this one, and is designed to be copied out to its own repository
unchanged. See `apps/lcp-stub-llm/README.md` for its own README.

## Running it

Manually, for local testing:

```sh
./scripts/run-stub-llm.sh --config path/to/config.json --port 3002
```

Or as part of the Docker Compose stack:

```sh
docker compose --profile integration up stub-llm
```

`--config`/`STUB_LLM_CONFIG_FILE` is optional — with none, every prompt gets
the built-in "no response configured" error until a config is pushed via
`PUT /stub/config`.

## Configuring behaviour

The config is a JSON (JSONC comments allowed) document of prompt-matching
rules and default responses:

```jsonc
{
  "key": "some-api-key-goes-here", // omit to disable auth
  "minDelay": 50, // ms, random per-word delay lower bound
  "maxDelay": 100, // ms, random per-word delay upper bound
  "prompts": [
    {
      "match": "[Ww]hat is the capital of", // regex tested against the joined message content
      "mode": "loop", // 'loop' | 'random' | 'sequence' (default)
      "responses": [
        { "text": "London", "tools": [] },
        { "text": "Paris", "tools": [] },
      ],
    },
  ],
  "defaults": {
    "mode": "sequence",
    "responses": [{ "text": "I didn't recognise your prompt.", "tools": [] }],
  },
}
```

- The first `prompts[]` rule whose `match` regex tests true against the
  request's joined message content wins; no match falls back to `defaults`;
  no `defaults` either is a 400 error.
- `sequence` (default) returns responses in order and errors once exhausted;
  `loop` returns them in order and wraps around; `random` picks uniformly.
- A response's `tools` become OpenAI-shaped `tool_calls` on the reply — the
  stub does not call them itself, it only emits the same shape a real LLM
  would. The caller's own agent loop dispatches them, exactly as it would a
  real LLM's tool calls.
- Real MCP tool names are `{mcpServerName}__{toolName}` (e.g.
  `lcp-mcp-tasks__complete_assignment`) — use that naming in test configs so
  the agent's tool-dispatch logic recognises them.

Full config reference, endpoint list, and the multi-format design (only
`openai` is implemented today) are in `apps/lcp-stub-llm/README.md`.

## How this suite uses it

`docker-compose.yml`'s `stub-llm` service (profile `integration`) is started
automatically by the integration tier's Jest global setup
(`test/integration/global-setup.ts`) via testcontainers, alongside
Postgres/Redis/MinIO — see [Testing](testing.md). `STUB_LLM_URL` is exposed to
spec files as an env var; tests configure it per-test via `PUT /stub/config`.

- `test/integration/lcp-server/chat-llm.integration-spec.ts` — a chat turn
  end-to-end against a single canned response.
- `test/integration/lcp-server/knowledge-reindex.integration-spec.ts` and
  `rag-retrieval-isolation.integration-spec.ts` — RAG indexing/retrieval
  against the stub's deterministic `/v1/embeddings`.
- `test/integration/lcp-agent/task-flow.integration-spec.ts` — a full
  task/assignment run driven by the real agent loop, using scripted tool
  calls to complete (and separately, to fail) an assignment.

## Replacing the previous stub

Earlier revisions of this suite used a much smaller stub
(`docker/stub-llm/server.js`, since removed) with a single canned response set
via `POST /stub/config`. `lcp-stub-llm` is its replacement — the endpoint
paths, port (3002), and `/health` check are unchanged, but `/stub/config` is
now a `GET`/`PUT` pair carrying the richer config shape above instead of a
bare `{ "response": "..." }`.
