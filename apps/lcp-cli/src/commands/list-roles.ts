import { Command } from 'commander';
import { apiRequest } from '../lib/api';
import { resolveToken } from '../lib/auth';

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
export function registerListRoles(program: Command): void {
  program
    .command('list-roles')
    .description('List roles grouped by company')
    .option('-c, --company-id <uuid>', 'Filter to a single company')
    .action(async (cmdOpts: { companyId?: string }) => {
      const opts = program.opts<{
        lcpServer: string;
        accessToken?: string;
        accessTokenEnvVar?: string;
        username?: string;
        password?: string;
      }>();
      try {
        const token = await resolveToken({ ...opts, baseUrl: opts.lcpServer });
        const api = { baseUrl: opts.lcpServer, token };

        let result: CompanyWithRoles[];

        if (cmdOpts.companyId) {
          const company = await apiRequest<CompanySummary>(
            api,
            'GET',
            `/api/company/${cmdOpts.companyId}`,
          );
          const roles = await apiRequest<RoleSummary[]>(
            api,
            'GET',
            `/api/company/${cmdOpts.companyId}/roles`,
          );
          result = [{ id: company.id, name: company.name, roles }];
        } else {
          const companies = await apiRequest<CompanySummary[]>(
            api,
            'GET',
            '/api/company',
          );
          result = await Promise.all(
            companies.map(async (c) => {
              const roles = await apiRequest<RoleSummary[]>(
                api,
                'GET',
                `/api/company/${c.id}/roles`,
              );
              return { id: c.id, name: c.name, roles };
            }),
          );
        }

        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      } catch (err) {
        process.stderr.write(
          `Error: ${String(err instanceof Error ? err.message : err)}\n`,
        );
        process.exit(1);
      }
    });
}
