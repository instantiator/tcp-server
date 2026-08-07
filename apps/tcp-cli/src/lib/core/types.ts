/**
 * Recursive partial — like `Partial<T>` but nested object properties are
 * also made partial. Equivalent to TypeORM's `DeepPartial<T>`.
 */
export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};
