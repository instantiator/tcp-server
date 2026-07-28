/**
 * Optional per-role or per-company overrides for agent run limits and
 * retrieval tuning.
 *
 * Values are applied in precedence order: {@link TcpRole.runConfig} →
 * {@link TcpCompany.runConfig} → environment variables → code defaults.
 * Any field left undefined falls through to the next level.
 */
export interface AgentRunConfig {
  /** Maximum number of LLM invocations before the run is cancelled as failed. */
  maxIterations?: number;
  /** Wall-clock timeout in milliseconds before the run is cancelled as failed. */
  timeoutMs?: number;
  /** Maximum QA rejections a task assignment may accrue before it fails. */
  maxQaAttempts?: number;
  /**
   * Minimum cosine similarity (0–1) a knowledge chunk must score to be
   * retrieved. Set per role/company when an embedding model's score
   * distribution differs from the default's — see
   * {@link DEFAULT_RAG_THRESHOLD}.
   */
  ragThreshold?: number;
}
