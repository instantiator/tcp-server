/**
 * Exposed port configuration — each port is independently configurable.
 */
export interface PortConfig {
  api: number;
  db: number;
  minio: number;
  minioConsole: number;
  zitadel: number;
}

/**
 * LLM provider configuration collected by the setup wizard.
 */
export interface LlmProviderConfig {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  /** Embedding vector dimension — only set for embedding models. */
  dimension?: number;
  /** Context window size — only set for chat/inference models. */
  contextWindow?: number;
}

/**
 * OIDC authentication configuration.
 */
export interface OidcConfig {
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
}

/**
 * Complete wizard output — all configuration collected from prompts.
 */
export interface WizardConfig {
  instanceName: string;
  envFileName: string;
  ports: PortConfig;
  embeddingModel?: LlmProviderConfig;
  inferenceModel?: LlmProviderConfig;
  oidc?: OidcConfig;
  agentIterations: number;
  agentConcurrency: number;
  /** Run the stub LLM in the stack (see prompts/docker.ts). */
  stubLlm: boolean;
}
