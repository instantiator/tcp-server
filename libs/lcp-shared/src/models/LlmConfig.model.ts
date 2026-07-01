/**
 * Configuration for a specific LLM provider and model.
 * The API key is stored directly in this config object and persisted in the database.
 * Ensure the database has encryption at rest to protect stored keys.
 */
export interface LlmConfig {
  /**
   * Identifies the provider. Known values: `'lm-studio'` (local OpenAI-compatible endpoint),
   * `'openai'`. Any string value is accepted to support future providers.
   */
  provider: string;

  /** The model identifier as expected by the provider API (e.g. `'gpt-4o'`, `'qwen3-5b'`). */
  model: string;

  /**
   * Base URL override for providers that are not hosted at their default endpoint.
   * Required for `'lm-studio'` (e.g. `'http://localhost:1234/v1'`).
   */
  baseUrl?: string;

  /**
   * API key for this provider.
   * Stored in the database as part of the JSONB config block.
   * Masked in API responses when `LCP_MASK_API_KEYS=true` (the default).
   */
  apiKey?: string;

  /**
   * Maximum context window for this model in tokens.
   * Used by {@link ContextBudgetService} to determine when compaction is needed.
   * Defaults to {@link DEFAULT_LLM_CONTEXT_WINDOW} when absent.
   */
  contextWindow?: number;

  /**
   * Per-request timeout in milliseconds for LLM API calls.
   * Defaults to {@link DEFAULT_LLM_TIMEOUT_MS} when absent. Set higher for slow local models.
   */
  timeoutMs?: number;
}
