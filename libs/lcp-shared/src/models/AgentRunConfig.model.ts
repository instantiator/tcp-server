/**
 * Optional per-role or per-company overrides for agent loop resource limits.
 *
 * Values are applied in precedence order: {@link LcpRole.runConfig} →
 * {@link LcpCompany.runConfig} → environment variables → code defaults.
 * Any field left undefined falls through to the next level.
 */
export interface AgentRunConfig {
  /** Maximum number of LLM invocations before the run is cancelled as failed. */
  maxIterations?: number;
  /** Wall-clock timeout in milliseconds before the run is cancelled as failed. */
  timeoutMs?: number;
}
