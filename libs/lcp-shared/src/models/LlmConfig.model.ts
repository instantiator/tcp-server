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
}
