import type { TcpRole } from '@tcp/shared';
import { apiOptions, GlobalOptions } from '../core/cli-options';
import { apiRequest, ApiOptions } from '../core/api';
import { confirmAction } from '../core/confirm';
import {
  EntityRefOpts,
  resolveCompanyId,
  resolveRoleId,
  UUID_RE,
} from '../core/entity-ref';
import { readJsonBody } from '../core/read-json-body';
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
  cmdOpts: { companyId?: string; companySlug?: string; company?: string },
): Promise<void> {
  return runCommand(async () => {
    const token = await resolveToken({ ...opts, baseUrl: opts.tcpServer });
    const api = apiOptions(opts, token);

    // `/api/company/:id` and `/api/company/:id/roles` both accept a UUID or
    // a slug directly, so the identifier is passed through as-is.
    const identifier =
      cmdOpts.companyId ?? cmdOpts.companySlug ?? cmdOpts.company;
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
  cmdOpts: EntityRefOpts & { input?: string },
): Promise<void> {
  return runCommand(async () => {
    const data = await readJsonBody(cmdOpts);
    const bodyId = typeof data['id'] === 'string' ? data['id'] : undefined;

    const token = await resolveToken({ ...opts, baseUrl: opts.tcpServer });
    const api = apiOptions(opts, token);

    const companyGiven = Boolean(
      cmdOpts.companyId || cmdOpts.companySlug || cmdOpts.company,
    );
    // A company flag overrides the body's companyId — needed on create, and
    // to scope a role-slug lookup (role slugs are unique only within a
    // company).
    let companyId =
      typeof data['companyId'] === 'string' ? data['companyId'] : undefined;
    if (companyGiven) {
      companyId = await resolveCompanyId(api, cmdOpts);
      data['companyId'] = companyId;
    }

    const roleSlugGiven =
      cmdOpts.roleSlug ??
      (cmdOpts.role && !UUID_RE.test(cmdOpts.role) ? cmdOpts.role : undefined);
    const roleId =
      cmdOpts.roleId ??
      (cmdOpts.role && UUID_RE.test(cmdOpts.role) ? cmdOpts.role : undefined) ??
      bodyId;

    let result: TcpRole;
    if (roleId) {
      result = await apiRequest<TcpRole>(
        api,
        'PUT',
        `/api/role/${roleId}`,
        data,
      );
    } else if (roleSlugGiven) {
      if (!companyId) {
        process.stderr.write(
          'Error: a role slug requires --company, --company-id, or --company-slug\n',
        );
        process.exit(1);
      }
      result = await apiRequest<TcpRole>(
        api,
        'PUT',
        `/api/company/${companyId}/roles/by-slug/${roleSlugGiven}`,
        data,
      );
    } else {
      if (!companyId) {
        process.stderr.write(
          'Error: --company, --company-id, or --company-slug is required when creating a new role\n',
        );
        process.exit(1);
      }
      result = await apiRequest<TcpRole>(api, 'POST', '/api/role', data);
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
  cmdOpts: EntityRefOpts & { force?: boolean },
): Promise<void> {
  return runCommand(async () => {
    const token = await resolveToken({ ...opts, baseUrl: opts.tcpServer });
    const api = apiOptions(opts, token);

    const roleId = await resolveRoleId(api, cmdOpts);
    // GET /api/role/:id throws a 404 (surfaced by runCommand) if it doesn't exist.
    const role = await apiRequest<TcpRole>(api, 'GET', `/api/role/${roleId}`);

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
