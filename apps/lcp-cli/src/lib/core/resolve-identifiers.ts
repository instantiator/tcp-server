import { ApiOptions, apiRequest } from './api';

/** Shared shape for commands that accept `--company-id`/`--company-slug`. */
export interface CompanyIdentifierOpts {
  companyId?: string;
  companySlug?: string;
}

/** Shared shape for commands that accept `--role-id`/`--role-slug` (plus a company identifier for the slug case). */
export interface RoleIdentifierOpts extends CompanyIdentifierOpts {
  roleId?: string;
  roleSlug?: string;
}

/**
 * Resolves a company UUID from `--company-id`/`--company-slug` options.
 * `--company-id` is used as-is (the server also accepts a slug there, but
 * resolving locally lets `--company-slug`-only flows fail fast with a clear
 * CLI error instead of a confusing 404 deep in a later call).
 *
 * @throws if neither option is given, or if the slug doesn't resolve.
 */
export async function resolveCompanyId(
  api: ApiOptions,
  opts: CompanyIdentifierOpts,
): Promise<string> {
  if (opts.companyId) return opts.companyId;
  if (opts.companySlug) {
    const company = await apiRequest<{ id: string }>(
      api,
      'GET',
      `/api/company/${opts.companySlug}`,
    );
    return company.id;
  }
  throw new Error('Provide either --company-id or --company-slug');
}

/**
 * Resolves a role UUID from `--role-id`/`--role-slug` options. Role slugs
 * are unique only within a company (not globally), so `--role-slug` also
 * requires `--company-id`/`--company-slug` to disambiguate.
 *
 * @throws if neither role option is given, if `--role-slug` is given without
 *   a company identifier, or if either identifier doesn't resolve.
 */
export async function resolveRoleId(
  api: ApiOptions,
  opts: RoleIdentifierOpts,
): Promise<string> {
  if (opts.roleId) return opts.roleId;
  if (opts.roleSlug) {
    const companyId = await resolveCompanyId(api, opts).catch(() => {
      throw new Error(
        '--role-slug requires --company-id or --company-slug (role slugs are only unique within a company)',
      );
    });
    const role = await apiRequest<{ id: string }>(
      api,
      'GET',
      `/api/company/${companyId}/roles/by-slug/${opts.roleSlug}`,
    );
    return role.id;
  }
  throw new Error('Provide either --role-id or --role-slug');
}
