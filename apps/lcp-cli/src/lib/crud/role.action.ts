import type { LcpRole } from '@lcp/shared';
import { apiOptions, GlobalOptions } from '../core/cli-options';
import { apiRequest, ApiOptions } from '../core/api';
import { readStdin } from '../core/stdin';
import { runCommand } from '../core/run-command';
import { resolveToken } from '../auth/token';

interface CompanySummary {
  id: string;
  name: string;
}

interface RoleSummary {
  id: string;
  name: string;
}

interface CompanyWithRoles {
  id: string;
  name: string;
  roles: RoleSummary[];
}

/**
 * Lists roles grouped by company.
 *
 * Without --company-id: fetches all companies then their roles (N+1 calls).
 * With --company-id: fetches a single company and its roles.
 *
 * stdout: `{ id, name, roles: { id, name }[] }[]`
 */
export function listRolesAction(
  opts: GlobalOptions,
  cmdOpts: { companyId?: string },
): Promise<void> {
  return runCommand(async () => {
    const token = await resolveToken({ ...opts, baseUrl: opts.lcpServer });
    const api = apiOptions(opts, token);

    const result = cmdOpts.companyId
      ? [await fetchCompanyWithRoles(api, cmdOpts.companyId)]
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
  return { id: company.id, name: company.name, roles };
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
  cmdOpts: { companyId?: string; input?: string },
): Promise<void> {
  return runCommand(async () => {
    const raw = cmdOpts.input ?? (await readStdin());
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      process.stderr.write('Error: input must be a JSON object\n');
      process.exit(1);
    }
    const data = parsed as Record<string, unknown>;
    const id = typeof data['id'] === 'string' ? data['id'] : undefined;

    // Merge --company-id into the input when creating
    if (!id && cmdOpts.companyId) {
      data['companyId'] = cmdOpts.companyId;
    }
    const companyId =
      typeof data['companyId'] === 'string' ? data['companyId'] : undefined;

    const token = await resolveToken({ ...opts, baseUrl: opts.lcpServer });
    const api = apiOptions(opts, token);

    let result: LcpRole;
    if (id) {
      result = await apiRequest<LcpRole>(api, 'PUT', `/api/role/${id}`, data);
    } else {
      if (!companyId) {
        process.stderr.write(
          'Error: --company-id is required when creating a new role\n',
        );
        process.exit(1);
      }
      result = await apiRequest<LcpRole>(api, 'POST', '/api/role', data);
    }
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  });
}
