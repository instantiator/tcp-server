import type { UploadDoor } from '../../api/hooks';

/**
 * Whether people may change `path` with the storage routes. Mirrors
 * `isWritable` in tcp-server's `company-storage-paths.ts`: the server
 * enforces it, this only shows it.
 */
export const isWritablePath = (path: string): boolean =>
  path.startsWith('resources/');

/** The folder holding `path` (a file, or a folder ending in `/`); `''` at the top. */
export const parentOf = (path: string): string =>
  path.slice(0, path.lastIndexOf('/', path.length - 2) + 1);

/** `knowledge/{scope}/`: the company's shared knowledge, or one role's by its slug. */
const KNOWLEDGE_SCOPE = /^knowledge\/([^/]+)\/$/;

/** `tasks/{id}/materials/`: a task's materials. */
const TASK_MATERIALS = /^tasks\/([^/]+)\/materials\/$/;

/**
 * The door an upload into `folder` goes through (002.10), or `null` where
 * nothing may be uploaded. `resources/` takes files as they are; a
 * knowledge scope and a task's `materials/` take them only through their own
 * routes, which convert and reindex, or add to the task's list. A role's
 * folder is found by its slug; one with no matching role takes nothing.
 * The server is the authority on every door; this only picks the route.
 */
export const doorFor = (
  folder: string,
  companyId: string,
  roleIdBySlug: ReadonlyMap<string, string>,
): UploadDoor | null => {
  if (isWritablePath(folder)) return { kind: 'storage' };
  const knowledge = KNOWLEDGE_SCOPE.exec(folder)?.[1];
  if (knowledge === 'shared') {
    return { kind: 'knowledge', scope: { kind: 'company', companyId } };
  }
  const roleId =
    knowledge === undefined ? undefined : roleIdBySlug.get(knowledge);
  if (roleId !== undefined) {
    return { kind: 'knowledge', scope: { kind: 'role', roleId } };
  }
  const taskId = TASK_MATERIALS.exec(folder)?.[1];
  return taskId === undefined ? null : { kind: 'materials', taskId };
};

/**
 * The name a file is stored under once it goes through `door`. Knowledge
 * keeps a `.md` name and turns anything else into `{name}.md`, copying
 * `toOkfDocument` in tcp-server's `knowledge-conversion.ts`, including its
 * quirk: the extension is matched in lower case, so `R.PDF` becomes
 * `R.PDF.md`. Every other door keeps the name.
 */
export const storedName = (name: string, door: UploadDoor): string => {
  if (door.kind !== 'knowledge') return name;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot).toLowerCase() : '';
  if (ext === '.md') return name;
  const base =
    ext !== '' && name.endsWith(ext) ? name.slice(0, -ext.length) : name;
  return `${base}.md`;
};
