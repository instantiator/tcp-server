import type { AgentRunConfig } from '../models/AgentRunConfig.model';
import type { LcpCompany } from '../models/LcpCompany.model';
import type { LcpRole } from '../models/LcpRole.model';

/**
 * Resolves a numeric {@link AgentRunConfig} value using the standard precedence
 * order: role → company → environment → code default.
 *
 * The first defined value wins. Pass `undefined` for any level that is not
 * available at the call site (e.g. when no company is set).
 *
 * @param key - The {@link AgentRunConfig} field to resolve.
 * @param role - The role for the current agent run (may be null).
 * @param company - The company for the current agent run (may be null).
 * @param envValue - Value from the relevant environment variable, or undefined.
 * @param defaultValue - Hard-coded fallback; always defined.
 */
export function resolveRunConfig(
  key: keyof AgentRunConfig,
  role: LcpRole | null,
  company: LcpCompany | null,
  envValue: number | undefined,
  defaultValue: number,
): number {
  return (
    role?.runConfig?.[key] ??
    company?.runConfig?.[key] ??
    envValue ??
    defaultValue
  );
}
