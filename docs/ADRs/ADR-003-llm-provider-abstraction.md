# ADR-003: LLM Provider Abstraction

Status: Proposed

## Context

The spec requires that each `TcpAgent` can use "whichever LLM service is specified" — including third-party APIs (Anthropic, OpenAI) or a locally hosted model served by LM Studio on a local network machine. The abstraction layer must be:

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

_(Generalised to every provider — see [below](#amendments-as-implemented-p03-004-01-00).)_

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

tcp-agent resolves the `BaseChatModel` instance at task step startup using this config. API keys are stored in the database as part of the `LlmConfig` JSONB block and masked (`***`) in API responses when `TCP_MASK_API_KEYS=true` (the default).

## Consequences

- No extra dependencies beyond LangGraph.js (ADR-002)
- LLM provider is a runtime config value, not a compile-time choice
- Adding a new provider = adding a new `provider` value and a small factory case in tcp-agent

## Open Questions / Assumptions

- Tool calling support varies by provider and model. ADR-002's LangGraph loop depends on tool calling (function calling). Verify that any configured model supports it before assigning it to a role that uses tools.
- LM Studio models that lack structured output support may require prompt-engineering workarounds. Note this in role documentation when a local model is used.

<a id="amendments-as-implemented-p03-004-01-00"></a>

## Amendments as implemented (phase 03, 004.01.00) — every provider through its OpenAI-compatible API

- **Provider ids come from one catalogue.** `libs/tcp-shared/src/llm/provider-catalogue.ts` lists the providers TCP supports, with each one's base URL, the fields a user supplies (API key, AWS region, Azure resource), starter chat and embedding models, and setup steps for local servers. The ids are `openai`, `anthropic`, `google`, `azure`, `amazon-bedrock`, `mistral`, `openrouter`, `lm-studio`, `ollama` and `openai-compatible`. It is plain data, so the setup wizard, CLI, TUI and web client can share it.
- **Every provider is a `ChatOpenAI` pointed at `baseUrl`.** `buildChatModel` accepts any catalogue id and passes `baseUrl` through. Before this, `openai` silently ignored `baseUrl`, and anything other than `openai` or `lm-studio` threw. An unknown id still throws. Local servers get a placeholder key when none is set. "Adding a new provider" (Consequences, above) is now a catalogue entry, not a factory case.
- **No native clients.** Anthropic, Google, Azure and Bedrock are reached through their OpenAI-compatible endpoints rather than `@langchain/anthropic` and similar, so no dependencies were added. The cost: Anthropic describes its compatibility layer as meant for testing, not production, and provider-specific features (prompt caching, for example) aren't available. Revisit if a provider's compatibility layer blocks real use.
- **Embeddings are limited to 2000 dimensions.** The vector indexes are pgvector `ivfflat`, which can't index wider vectors, so the catalogue lists no wider embedding model (`MAX_EMBEDDING_DIMENSION`). Anthropic, Bedrock's compatible API and OpenRouter offer no embedding models, and Gemini's are 3072 wide by default.
- **Only LM Studio has been run for real.** The other providers' URLs were checked against their documentation on 2026-09-30, not against a live key. See [outstanding issues](../outstanding-issues.md).
