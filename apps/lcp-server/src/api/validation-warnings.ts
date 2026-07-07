import type { LcpCompany, LcpRole } from '@lcp/shared';
import type { Response } from 'express';

/** Header used to report soft data-quality warnings without changing the response body shape. */
export const WARNINGS_HEADER = 'X-Lcp-Warnings';

/** Sets {@link WARNINGS_HEADER} as a JSON array, or omits it entirely when there are no warnings. */
export function setWarningsHeader(res: Response, warnings: string[]): void {
  if (warnings.length > 0) {
    res.setHeader(WARNINGS_HEADER, JSON.stringify(warnings));
  }
}

/**
 * Computes soft data-quality warnings for a role. These conditions are
 * technically valid (the action proceeds regardless) but inadvisable —
 * surfaced via the `X-Lcp-Warnings` response header, not a validation error.
 */
export function computeRoleWarnings(role: LcpRole): string[] {
  const warnings: string[] = [];
  if (!role.knowledgeDomains || role.knowledgeDomains.length === 0) {
    warnings.push('Role has no knowledgeDomains set.');
  }
  if (!role.rolePrompt?.trim()) {
    warnings.push('Role has a blank or missing rolePrompt.');
  }
  return warnings;
}

/** Computes soft data-quality warnings for a company (see {@link computeRoleWarnings}). */
export function computeCompanyWarnings(company: LcpCompany): string[] {
  const warnings: string[] = [];
  if (!company.companyContext?.trim()) {
    warnings.push('Company has a blank or missing companyContext.');
  }
  return warnings;
}
