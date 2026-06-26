import { Command } from 'commander';
import { apiRequest } from '../lib/api';
import { resolveToken } from '../lib/auth';

interface DocumentSummary {
  key: string;
  name: string;
  size: number;
  lastModified: string;
}

/**
 * Lists OKF knowledge-base documents stored for a role.
 *
 * stdout: JSON array of `{ key, name, size, lastModified }` objects.
 * An empty array is printed when the role has no documents.
 */
export function registerListRoleDocuments(program: Command): void {
  program
    .command('list-role-documents')
    .description('List knowledge-base documents stored for a role')
    .requiredOption('-r, --role-id <uuid>', 'Role UUID')
    .action(async (cmdOpts: { roleId: string }) => {
      const opts = program.opts<{
        lcpServer: string;
        accessToken?: string;
        accessTokenEnvVar?: string;
        username?: string;
        password?: string;
      }>();
      try {
        const token = await resolveToken({ ...opts, baseUrl: opts.lcpServer });
        const docs = await apiRequest<DocumentSummary[]>(
          { baseUrl: opts.lcpServer, token },
          'GET',
          `/api/role/${cmdOpts.roleId}/documents`,
        );
        process.stdout.write(JSON.stringify(docs, null, 2) + '\n');
      } catch (err) {
        process.stderr.write(
          `Error: ${String(err instanceof Error ? err.message : err)}\n`,
        );
        process.exit(1);
      }
    });
}
