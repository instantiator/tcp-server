/**
 * Object-key structure helpers for the shared document store, grouped here so
 * future key layouts (task materials/output, finished artefacts, audit
 * export — see ADR-007) have one obvious place to live alongside this one.
 */

/** Object key for a role's knowledge-base document: `{companySlug}/knowledge/{roleName}/{filename}`. */
export function knowledgeKey(
  companySlug: string,
  roleName: string,
  filename: string,
): string {
  return `${companySlug}/knowledge/${roleName}/${filename}`;
}

// Future additions (not yet implemented — ADR-007 bucket layout):
// - taskMaterialsKey(companySlug, taskId, filename)
// - taskOutputKey(companySlug, taskId, filename)
// - finishedArtefactKey(companySlug, category, taskId, filename)
// - auditExportKey(companySlug, taskId, stepId)
