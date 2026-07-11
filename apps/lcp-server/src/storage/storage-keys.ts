/**
 * Object-key structure helpers for the shared document store, grouped here so
 * future key layouts (task materials/output, finished artefacts, audit
 * export — see ADR-007) have one obvious place to live alongside this one.
 */

/**
 * Role slug reserved for company-wide knowledge (the `knowledge/shared/`
 * folder). No {@link LcpRole} may claim this slug — enforced in
 * `DbService.setRole`.
 */
export const SHARED_KNOWLEDGE_ROLE_SLUG = 'shared';

/**
 * Identifies a knowledge-store scope: either a specific role's folder, or
 * (when `roleSlug` is `null`) the company-wide `knowledge/shared/` folder.
 */
export interface KnowledgeScope {
  companySlug: string;
  roleSlug: string | null;
}

/** Object key for a role's knowledge-base document: `{companySlug}/knowledge/{roleSlug}/{filename}`. */
export function knowledgeKey(
  companySlug: string,
  roleSlug: string,
  filename: string,
): string {
  return `${companySlug}/knowledge/${roleSlug}/${filename}`;
}

/** Object key for a company-shared knowledge-base document: `{companySlug}/knowledge/shared/{filename}`. */
export function sharedKnowledgeKey(
  companySlug: string,
  filename: string,
): string {
  return `${companySlug}/knowledge/${SHARED_KNOWLEDGE_ROLE_SLUG}/${filename}`;
}

/** Prefix under which a role's knowledge-base documents are listed: `{companySlug}/knowledge/{roleSlug}/`. */
export function knowledgePrefix(companySlug: string, roleSlug: string): string {
  return `${companySlug}/knowledge/${roleSlug}/`;
}

/** Prefix under which company-shared knowledge-base documents are listed: `{companySlug}/knowledge/shared/`. */
export function sharedKnowledgePrefix(companySlug: string): string {
  return `${companySlug}/knowledge/${SHARED_KNOWLEDGE_ROLE_SLUG}/`;
}

/** Object key for a document in the given {@link KnowledgeScope} (role folder, or `shared/` when `roleSlug` is `null`). */
export function knowledgeScopeKey(
  scope: KnowledgeScope,
  filename: string,
): string {
  return scope.roleSlug === null
    ? sharedKnowledgeKey(scope.companySlug, filename)
    : knowledgeKey(scope.companySlug, scope.roleSlug, filename);
}

/** Listing prefix for the given {@link KnowledgeScope} (role folder, or `shared/` when `roleSlug` is `null`). */
export function knowledgeScopePrefix(scope: KnowledgeScope): string {
  return scope.roleSlug === null
    ? sharedKnowledgePrefix(scope.companySlug)
    : knowledgePrefix(scope.companySlug, scope.roleSlug);
}

// Future additions (not yet implemented — ADR-007 bucket layout):
// - taskMaterialsKey(companySlug, taskId, filename)
// - taskOutputKey(companySlug, taskId, filename)
// - finishedArtefactKey(companySlug, category, taskId, filename)
// - auditExportKey(companySlug, taskId, stepId)
