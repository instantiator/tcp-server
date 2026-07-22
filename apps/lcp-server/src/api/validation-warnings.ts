import type { LcpCompany, LcpRole, LlmConfig } from '@lcp/shared';
import { resolveEmbeddingConfig } from '@lcp/shared';
import { Logger } from '@nestjs/common';
import type { Response } from 'express';

/** Header used to report soft data-quality warnings without changing the response body shape. */
export const WARNINGS_HEADER = 'X-Lcp-Warnings';

const logger = new Logger('validation-warnings');

/**
 * Sets {@link WARNINGS_HEADER} as a JSON array, or omits it entirely when
 * there are no warnings.
 *
 * Each warning is `encodeURIComponent`-ed first: some warning content (e.g.
 * {@link KnowledgeService.embeddingWarnings}'s "last reindex failed"
 * message) embeds an arbitrary third-party error string, and Node's strict
 * HTTP header validation rejects non-Latin1 characters outright (throws
 * `Invalid character in header content`). Percent-encoding keeps every
 * character ASCII, so no warning content is ever lost to this — the CLI's
 * `reportWarnings` decodes each entry back before printing it (see
 * `apps/lcp-cli/src/lib/core/api.ts`).
 *
 * The try/catch is a backstop, not the primary defence: a malformed warning
 * must never break an otherwise-successful request, so on the off chance
 * something still isn't encodable this swallows the failure and just omits
 * the header rather than propagating the error.
 */
export function setWarningsHeader(res: Response, warnings: string[]): void {
  if (warnings.length === 0) return;
  try {
    const encoded = warnings.map((w) => encodeURIComponent(w));
    res.setHeader(WARNINGS_HEADER, JSON.stringify(encoded));
  } catch (err) {
    logger.warn(
      `Failed to set ${WARNINGS_HEADER} header: ${err instanceof Error ? err.message : String(err)}`,
    );
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

/**
 * Warns when no embedding config can be resolved for a company (its own
 * `embeddingConfig`, nor the `EMBEDDING_*` env fallback) — RAG knowledge
 * indexing and search are silently disabled in that case (see
 * {@link resolveEmbeddingConfig}), which is otherwise invisible until
 * someone notices an index stuck at zero chunks.
 */
export function computeEmbeddingConfigWarning(
  company: LcpCompany,
  envFallback: LlmConfig | null | undefined,
): string[] {
  if (resolveEmbeddingConfig(company, envFallback)) return [];
  return [
    // Plain ASCII by convention (setWarningsHeader percent-encodes this
    // regardless, so it's no longer a hard requirement — just keeps log/CLI
    // output free of encoding noise for a string we fully control).
    'No embedding config resolved for this company. RAG indexing and search are disabled. ' +
      'Set embeddingConfig on the company, or EMBEDDING_PROVIDER/EMBEDDING_MODEL env vars.',
  ];
}
