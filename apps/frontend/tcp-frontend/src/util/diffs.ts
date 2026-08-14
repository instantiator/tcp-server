/** Represents a change to an object of type T, retaining the id */
export type PatchOf<T> = Partial<T> & { id: string };

/**
 * Compares two lists of objects.
 * @param prev previous version of a `T[]`
 * @param next updated version of the `T[]`
 * @returns an object containing the created, removed, and updated items between the two arrays,
 *   where `updated` is an array of patches that can be applied to the previous version to get the next version.
 */
export const diffList = <T extends { id: string }>(
  prev: readonly T[],
  next: readonly T[],
): { created: T[]; removed: T[]; updated: PatchOf<T>[]; any: boolean } => {
  const prevById = new Map(prev.map((item) => [item.id, item]));
  const nextById = new Map(next.map((item) => [item.id, item]));

  const created = next.filter((item) => !prevById.has(item.id));
  const removed = prev.filter((item) => !nextById.has(item.id));

  const both = next.filter((item) => prevById.has(item.id));
  const updated = both
    .map((item) => diffObject(prevById.get(item.id)!, item))
    .filter((patch): patch is NonNullable<typeof patch> => patch !== null);

  const any = created.length > 0 || removed.length > 0 || updated.length > 0;

  return { created, removed, updated, any };
};

export const diffObject = <T extends { id: string }>(
  prev: T,
  next: T,
): PatchOf<T> | null => {
  const patch: Partial<T> = {};
  let changed = false;
  for (const key of Object.keys(next) as (keyof T)[]) {
    if (!Object.is(prev[key], next[key])) {
      patch[key] = next[key];
      changed = true;
    }
  }
  return changed ? { ...patch, id: next.id } : null;
};
