# ADR-003: LLM Provider Abstraction

Status: Proposed

## Context

The spec requires that each `LcpAgent` can use "whichever LLM service is specified" — including third-party APIs (Anthropic, OpenAI) or a locally hosted model served by LM Studio on a local network machine. The abstraction layer must be:

1. Easy to swap per agent/role without changing the agent loop code
2. Compatible with LangGraph.js (see [ADR-002](./ADR-002-agent-loop-framework.md))
3. Able to reach non-standard endpoints (LM Studio exposes an OpenAI-compatible REST API at a configurable host)

## Options

| Option                                          | Notes                                                                                                                                                                                                              |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **LangChain model interface** (`BaseChatModel`) | Built-in to LangGraph.js. `ChatAnthropic`, `ChatOpenAI`, `ChatGoogleGenerativeAI`, etc. LM Studio works as `ChatOpenAI` with a custom `baseURL`. Zero extra dependencies if LangGraph is already chosen (ADR-002). |
| **Vercel AI SDK** (`ai`)                        | Provider-agnostic, TypeScript-first. Works without LangChain. Adds a dependency; would require an adapter to plug into LangGraph's `BaseChatModel`.                                                                |
| **Custom thin wrapper**                         | Full control; no framework lock-in. Adds maintenance burden; duplicates what LangChain already provides.                                                                                                           |

## Decision

**LangChain model interface (`BaseChatModel`)**, already included with LangGraph.js.

### LM Studio compatibility

LM Studio exposes an OpenAI-compatible chat completions endpoint. Configure it as:

```typescript
new ChatOpenAI({
  model: 'local-model-name',
  apiKey: 'lm-studio', // LM Studio ignores the key but requires a value
  configuration: {
    baseURL: 'http://192.168.1.x:1234/v1', // LM Studio address on local network
  },
});
```

### Per-role LLM config

Each role definition carries an `llm_config` block (see [ADR-010](./ADR-010-orchestration-design.md) for the full role schema):

```typescript
interface LlmConfig {
  provider: 'anthropic' | 'openai' | 'lm-studio' | string;
  model: string;
  baseUrl?: string; // override for LM Studio or other custom endpoints
  apiKey?: string; // stored in the database; masked in API responses by default
}
```

lcp-agent resolves the `BaseChatModel` instance at task step startup using this config. API keys are stored in the database as part of the `LlmConfig` JSONB block and masked (`***`) in API responses when `LCP_MASK_API_KEYS=true` (the default).

## Consequences

- No extra dependencies beyond LangGraph.js (ADR-002)
- LLM provider is a runtime config value, not a compile-time choice
- Adding a new provider = adding a new `provider` value and a small factory case in lcp-agent

## Open Questions / Assumptions

- Tool calling support varies by provider and model. ADR-002's LangGraph loop depends on tool calling (function calling). Verify that any configured model supports it before assigning it to a role that uses tools.
- LM Studio models that lack structured output support may require prompt-engineering workarounds. Note this in role documentation when a local model is used.
