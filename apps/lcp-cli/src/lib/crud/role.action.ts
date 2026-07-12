import type { LcpRole } from '@lcp/shared';
import { apiOptions, GlobalOptions } from '../core/cli-options';
import { apiRequest, ApiOptions } from '../core/api';
import { confirmAction } from '../core/confirm';
import {
  CompanyIdentifierOpts,
  RoleIdentifierOpts,
  resolveCompanyId,
  resolveRoleId,
} from '../core/resolve-identifiers';
import { readStdin } from '../core/stdin';
import { runCommand } from '../core/run-command';
import { resolveToken } from '../auth/token';

interface CompanySummary {
  id: string;
  slug: string;
  name: string;
  description: string;
}

interface RoleSummary {
  id: string;
  slug: string;
  name: string;
  description: string;
  knowledgeDomains: string[];
}

interface CompanyWithRoles {
  id: string;
  slug: string;
  name: string;
  description: string;
  roles: RoleSummary[];
}

/**
 * Lists roles grouped by company.
 *
 * Without --company-id: fetches all companies then their roles (N+1 calls).
 * With --company-id: fetches a single company and its roles.
 *
 * stdout: `{ id, slug, name, description, roles: { id, slug, name, description, knowledgeDomains }[] }[]`
 */
export function listRolesAction(
  opts: GlobalOptions,
  cmdOpts: { companyId?: string; companySlug?: string },
): Promise<void> {
  return runCommand(async () => {
    const token = await resolveToken({ ...opts, baseUrl: opts.lcpServer });
    const api = apiOptions(opts, token);

    // `/api/company/:id` and `/api/company/:id/roles` both accept a UUID or
    // a slug directly, so the identifier is passed through as-is.
    const identifier = cmdOpts.companyId ?? cmdOpts.companySlug;
    const result = identifier
      ? [await fetchCompanyWithRoles(api, identifier)]
      : await fetchAllCompaniesWithRoles(api);

    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  });
}

async function fetchCompanyWithRoles(
  api: ApiOptions,
  companyId: string,
): Promise<CompanyWithRoles> {
  const company = await apiRequest<CompanySummary>(
    api,
    'GET',
    `/api/company/${companyId}`,
  );
  const roles = await apiRequest<RoleSummary[]>(
    api,
    'GET',
    `/api/company/${companyId}/roles`,
  );
  return {
    id: company.id,
    slug: company.slug,
    name: company.name,
    description: company.description,
    roles: roles.map(({ id, slug, name, description, knowledgeDomains }) => ({
      id,
      slug,
      name,
      description,
      knowledgeDomains,
    })),
  };
}

async function fetchAllCompaniesWithRoles(
  api: ApiOptions,
): Promise<CompanyWithRoles[]> {
  const companies = await apiRequest<CompanySummary[]>(
    api,
    'GET',
    '/api/company',
  );
  return Promise.all(
    companies.map((company) => fetchCompanyWithRoles(api, company.id)),
  );
}

/** Creates or updates a role from JSON (`--input` or stdin). */
export function setRoleAction(
  opts: GlobalOptions,
  cmdOpts: CompanyIdentifierOpts & {
    roleId?: string;
    roleSlug?: string;
    input?: string;
  },
): Promise<void> {
  return runCommand(async () => {
    const raw = cmdOpts.input ?? (await readStdin());
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      process.stderr.write('Error: input must be a JSON object\n');
      process.exit(1);
    }
    const data = parsed as Record<string, unknown>;
    const bodyId = typeof data['id'] === 'string' ? data['id'] : undefined;

    const token = await resolveToken({ ...opts, baseUrl: opts.lcpServer });
    const api = apiOptions(opts, token);

    // A --company-id/--company-slug flag overrides the body's companyId —
    // needed on create, and to scope a --role-slug lookup (role slugs are
    // unique only within a company).
    let companyId =
      typeof data['companyId'] === 'string' ? data['companyId'] : undefined;
    if (cmdOpts.companyId || cmdOpts.companySlug) {
      companyId = await resolveCompanyId(api, cmdOpts);
      data['companyId'] = companyId;
    }

    const roleId = cmdOpts.roleId ?? bodyId;

    let result: LcpRole;
    if (roleId) {
      result = await apiRequest<LcpRole>(
        api,
        'PUT',
        `/api/role/${roleId}`,
        data,
      );
    } else if (cmdOpts.roleSlug) {
      if (!companyId) {
        process.stderr.write(
          'Error: --role-slug requires --company-id or --company-slug\n',
        );
        process.exit(1);
      }
      result = await apiRequest<LcpRole>(
        api,
        'PUT',
        `/api/company/${companyId}/roles/by-slug/${cmdOpts.roleSlug}`,
        data,
      );
    } else {
      if (!companyId) {
        process.stderr.write(
          'Error: --company-id or --company-slug is required when creating a new role\n',
        );
        process.exit(1);
      }
      result = await apiRequest<LcpRole>(api, 'POST', '/api/role', data);
    }
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  });
}

/**
 * Deletes a role (and, via cascade, its agents, knowledge chunks, episodic
 * memory, and conversations).
 *
 * Checks the role exists first; unless `--force` is given, asks for y/n
 * confirmation before deleting. `--role-slug` requires `--company-id`/
 * `--company-slug` (role slugs are only unique within a company).
 */
export function deleteRoleAction(
  opts: GlobalOptions,
  cmdOpts: RoleIdentifierOpts & { force?: boolean },
): Promise<void> {
  return runCommand(async () => {
    const token = await resolveToken({ ...opts, baseUrl: opts.lcpServer });
    const api = apiOptions(opts, token);

    const roleId = await resolveRoleId(api, cmdOpts);
    // GET /api/role/:id throws a 404 (surfaced by runCommand) if it doesn't exist.
    const role = await apiRequest<LcpRole>(api, 'GET', `/api/role/${roleId}`);

    if (!cmdOpts.force) {
      const confirmed = await confirmAction(
        `Delete role "${role.name}" (${role.slug})?`,
      );
      if (!confirmed) {
        process.stderr.write('Aborted.\n');
        return;
      }
    }

    await apiRequest(api, 'DELETE', `/api/role/${role.id}`);
    process.stdout.write(`Deleted role ${role.id} (${role.slug})\n`);
  });
}
