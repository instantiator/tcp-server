# tcp-stub-llm

A configurable stub LLM server for testing LLM/agentic systems. It simulates a
real provider's chat-completions API, replying to prompts with pre-scripted
text and tool calls instead of running an actual model — useful for
deterministic, fast, offline tests of anything that talks to an LLM.

Zero runtime dependencies: it's plain TypeScript, run directly by Node's
native type-stripping (no build step). It shares no code with any other
application in this repository, so it can be copied out to its own repository
unchanged.

## Running it

```sh
node src/main.ts --config ./my-config.json --port 3002
```

Both flags are optional — `--port` defaults to `3002` (or `$PORT`), and
`--config` defaults to `$STUB_LLM_CONFIG_FILE`. With no config at all, every
request falls back to the built-in "no response configured" error, which is
enough for a `/health` check or for tests that only set behaviour later via
`PUT /stub/config`.

## Config file

A JSON (or JSONC — `//` and `/* */` comments are stripped before parsing)
document:

```jsonc
{
  "apiFormat": "openai", // the only value supported today
  "key": "some-api-key-goes-here", // omit to disable auth entirely
  "minDelay": 50, // lower bound of the random per-word delay (ms)
  "maxDelay": 100, // upper bound of the random per-word delay (ms)
  "prompts": [
    {
      "match": "[Ww]hat is the capital of", // a regex — plain substrings are valid regexes too
      "mode": "loop", // 'loop' | 'random' | 'sequence' (default)
      "responses": [
        { "text": "London", "tools": [] },
        {
          "text": "Paris",
          "tools": [
            {
              "tool": "tcp-mcp-tasks__complete_assignment",
              "data": { "summary": "done" },
            },
          ],
        },
      ],
    },
  ],
  "defaults": {
    "mode": "sequence",
    "responses": [
      { "text": "I didn't recognise your prompt.", "tools": [] },
      { "text": "I still didn't recognise your prompt.", "tools": [] },
    ],
  },
}
```

- **Matching**: the first `prompts[]` rule whose `match` regex tests true
  against the concatenated content of the request's `messages[]` wins. No
  match falls back to `defaults`; no `defaults` either is a 400 error.
- **Modes**: `sequence` (default) returns responses in order and errors once
  exhausted; `loop` returns them in order and wraps around forever; `random`
  picks uniformly at random each call.
- **Tools**: a response's `tools` become OpenAI-shaped `tool_calls` on the
  reply — the stub does not call them itself, it only emits the same shape a
  real LLM would, for the caller's own tool-dispatch loop to execute.
- **Delay**: `minDelay`/`maxDelay` are read as a random per-word delay (ms);
  unset or `0` on both means instant responses.

## Endpoints

| Method & path               | Purpose                                                           |
| --------------------------- | ----------------------------------------------------------------- |
| `GET /health`               | Liveness check.                                                   |
| `POST /v1/chat/completions` | The active format's chat endpoint (streaming via `stream: true`). |
| `POST /v1/embeddings`       | Deterministic, unit-norm embeddings (always OpenAI-shaped).       |
| `GET /stub/last-request`    | The most recent chat-completion request body (or `null`).         |
| `GET /stub/config`          | The active config (`key` masked).                                 |
| `PUT /stub/config`          | Replaces the active config and resets all response cursors.       |

## Other wire formats

Only `openai` is implemented, since it's the only format this repository's
LLM client (`@langchain/openai`) speaks. The request/response handling is
behind a small per-format adapter (`src/formats/api-format.ts`) so another
provider — e.g. the Anthropic Messages API, Ollama, or Google Gemini — can be
added later as its own `src/formats/<name>.ts` without touching the matching,
delay, or auth logic.

## Tests

```sh
npm test           # everything under test/ (unit + e2e)
npm run typecheck
npm run lint:check
```
