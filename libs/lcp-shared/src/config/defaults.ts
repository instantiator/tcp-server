/**
 * Single source of truth for code-level config defaults — the fallback used
 * when a value isn't set anywhere in the resolution chain (role/company
 * `runConfig` → env var → here). Centralised so every default is defined
 * once and easy to find from either direction (the field that uses it, or
 * this file).
 */

/**
 * Default maximum LLM invocations per agent run.
 * Overridden by `AGENT_ITERATIONS` (lcp-agent env), then by
 * {@link AgentRunConfig.maxIterations} via {@link resolveRunConfig}.
 * Used in {@link AgentLoopService.run}.
 */
export const DEFAULT_AGENT_ITERATIONS = 10;

/**
 * Default wall-clock timeout in milliseconds for an entire agent run.
 * Overridden by `AGENT_LOOP_TIMEOUT_MS` (lcp-agent env), then by
 * {@link AgentRunConfig.timeoutMs} via {@link resolveRunConfig}.
 * Used in {@link AgentLoopService.run}.
 *
 * Kept >= {@link DEFAULT_LLM_TIMEOUT_MS}: a run-level timeout shorter than a
 * single LLM call's own timeout would abort the run before that call could
 * ever legitimately finish, making the per-call timeout pointless.
 */
export const DEFAULT_AGENT_LOOP_TIMEOUT_MS = 30 * 60 * 1000; // 30m

/**
 * Default number of reminder retries when an agent run ends without all of its
 * required tool calls (see {@link LcpAgent.requiredToolCalls}) having fired.
 * Overridden by `AGENT_REQUIRED_TOOL_RETRIES` (lcp-agent env).
 * Used in {@link AgentLoopService}.
 */
export const DEFAULT_REQUIRED_TOOL_RETRIES = 2;

/**
 * Default per-request timeout in milliseconds for a single LLM API call.
 * Overridden by `LlmConfig.timeoutMs` (set via `LLM_TIMEOUT_MS` env when
 * built by {@link resolveEnvLlmConfig}, or stored directly on a role/company
 * `llmConfig`).
 * Used in {@link buildChatModel}.
 */
export const DEFAULT_LLM_TIMEOUT_MS = 30 * 60 * 1000; // 30m

/**
 * Default context window size in tokens, used when {@link LlmConfig.contextWindow}
 * is not set.
 * Used in {@link ContextBudgetService.DEFAULT_WINDOW} and {@link ChatService.sendMessage}.
 */
export const DEFAULT_LLM_CONTEXT_WINDOW = 8192;
