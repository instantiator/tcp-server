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
 * Docker Compose service selection.
 */
export interface DockerConfig {
  postgres: boolean;
  redis: boolean;
  minio: boolean;
  zitadel: boolean;
  stubLlm: boolean;
}

/**
 * Complete wizard output — all configuration collected from prompts.
 */
export interface WizardConfig {
  instanceName: string;
  envFileName: string;
  embeddingModel?: LlmProviderConfig;
  inferenceModel?: LlmProviderConfig;
  oidc?: OidcConfig;
  agentIterations: number;
  agentConcurrency: number;
  docker: DockerConfig;
}
