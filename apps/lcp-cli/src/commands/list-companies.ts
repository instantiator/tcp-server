import { Command } from 'commander';
import { apiRequest } from '../lib/api';
import { resolveToken } from '../lib/auth';

interface CompanySummary {
  id: string;
  name: string;
}

/** Lists all companies from the LCP server and writes them to stdout as JSON. */
export function registerListCompanies(program: Command): void {
  program
    .command('list-companies')
    .description('List all companies')
    .action(async () => {
      const opts = program.opts<{
        lcpServer: string;
        accessToken?: string;
        accessTokenEnvVar?: string;
        username?: string;
        password?: string;
      }>();
      try {
        const token = await resolveToken({ ...opts, baseUrl: opts.lcpServer });
        const companies = await apiRequest<CompanySummary[]>(
          { baseUrl: opts.lcpServer, token },
          'GET',
          '/api/company',
        );
        process.stdout.write(
          JSON.stringify(
            companies.map(({ id, name }) => ({ id, name })),
            null,
            2,
          ) + '\n',
        );
      } catch (err) {
        process.stderr.write(
          `Error: ${String(err instanceof Error ? err.message : err)}\n`,
        );
        process.exit(1);
      }
    });
}
