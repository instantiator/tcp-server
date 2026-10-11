/**
 * A table's fields in the order people see them: the primary key's fields
 * first, then the rest alphabetically. Postgres `jsonb` doesn't keep the order
 * an agent declared them in, so this is the one order the CSV and the web
 * sheet both use.
 */
export function fieldOrder(definition: {
  readonly schema: { readonly properties: Readonly<Record<string, unknown>> };
  readonly primaryKey: readonly string[];
}): string[] {
  const rest = Object.keys(definition.schema.properties)
    .filter((f) => !definition.primaryKey.includes(f))
    .sort();
  return [...definition.primaryKey, ...rest];
}
