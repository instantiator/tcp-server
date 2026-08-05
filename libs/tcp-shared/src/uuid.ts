/**
 * A UUID string, structurally identical to `crypto`'s `UUID`.
 *
 * The entity models use this type in fields that reach the browser through
 * `@tcp/shared/client`. Importing it from `crypto` made the shared *type*
 * surface depend on `@types/node`, which forced the browser workspace to
 * declare Node types it must not have — and once declared, `Buffer` and
 * `process` typecheck happily in browser code and fail at runtime.
 *
 * `crypto.randomUUID()` still assigns to this without a cast: the definition
 * is the same template literal type (`@types/node`, crypto.d.ts).
 */
export type UUID = `${string}-${string}-${string}-${string}-${string}`;
