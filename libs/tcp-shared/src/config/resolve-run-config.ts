import type { AgentRunConfig } from '../models/AgentRunConfig.model';
import type { TcpCompany } from '../models/TcpCompany.model';
import type { TcpRole } from '../models/TcpRole.model';

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
  role: TcpRole | null,
  company: TcpCompany | null,
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
