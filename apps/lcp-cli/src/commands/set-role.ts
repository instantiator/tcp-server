import { Command } from 'commander';
import { apiRequest } from '../lib/api';
import { resolveToken } from '../lib/auth';
import type { LcpRole } from '@lcp/shared';

/** Creates or updates a role. Reads JSON from --input or stdin. */
export function registerSetRole(program: Command): void {
  program
    .command('set-role')
    .description('Create or update a role (reads JSON from --input or stdin)')
    .option(
      '-c, --company-id <uuid>',
      'Company UUID (required when creating a new role)',
    )
    .option('-i, --input <json>', 'Role JSON (DeepPartial<LcpRole>)')
    .action(async (cmdOpts: { companyId?: string; input?: string }) => {
      const opts = program.opts<{
        lcpServer: string;
        accessToken?: string;
        accessTokenEnvVar?: string;
        username?: string;
        password?: string;
      }>();
      try {
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
        const api = { baseUrl: opts.lcpServer, token };

        let result: LcpRole;
        if (id) {
          result = await apiRequest<LcpRole>(
            api,
            'PUT',
            `/api/role/${id}`,
            data,
          );
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
      } catch (err) {
        process.stderr.write(
          `Error: ${String(err instanceof Error ? err.message : err)}\n`,
        );
        process.exit(1);
      }
    });
}

/** Reads all of stdin as a string. */
function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}
