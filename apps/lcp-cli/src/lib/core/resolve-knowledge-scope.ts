import { ApiOptions, apiRequest } from './api';

/** Matches a canonical UUID (case-insensitive). */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Shared shape for the `list-knowledge`/`get-knowledge`/`store-knowledge`/`delete-knowledge` verbs. */
export interface KnowledgeScopeOpts {
  role?: string;
  company?: string;
}

/**
 * Resolves `--role`/`--company` into the API path segment identifying the
 * knowledge scope: `role/<uuid>` or `company/<slug-or-id>`.
 *
 * A `--role` value is treated as a UUID when it looks like one, otherwise as
 * a role slug — which additionally requires `--company` (role slugs are
 * unique only within a company, not globally). `--company` is used as-is;
 * the server's company routes accept either a UUID or a slug directly.
 *
 * @throws if neither `--role` nor `--company` is given, or if a role slug is
 *   given without `--company` to resolve it against.
 */
export async function resolveKnowledgeScopePath(
  api: ApiOptions,
  opts: KnowledgeScopeOpts,
): Promise<string> {
  if (opts.role) {
    if (UUID_RE.test(opts.role)) return `role/${opts.role}`;
    if (!opts.company) {
      throw new Error(
        '--role <slug> requires --company <slug-or-id> to resolve it (role slugs are unique only within a company)',
      );
    }
    const role = await apiRequest<{ id: string }>(
      api,
      'GET',
      `/api/company/${opts.company}/roles/by-slug/${opts.role}`,
    );
    return `role/${role.id}`;
  }
  if (opts.company) return `company/${opts.company}`;
  throw new Error(
    'Provide either --role <slug-or-id> or --company <slug-or-id>',
  );
}
