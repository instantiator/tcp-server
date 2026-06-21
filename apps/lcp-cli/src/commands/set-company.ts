import { Command } from 'commander';
import { apiRequest } from '../lib/api';
import { resolveToken } from '../lib/auth';
import type { LcpCompany } from '@lcp/shared';

/** Creates or updates a company. Reads JSON from --input or stdin. */
export function registerSetCompany(program: Command): void {
  program
    .command('set-company')
    .description(
      'Create or update a company (reads JSON from --input or stdin)',
    )
    .option('-i, --input <json>', 'Company JSON (DeepPartial<LcpCompany>)')
    .action(async (cmdOpts: { input?: string }) => {
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

        const token = await resolveToken({ ...opts, baseUrl: opts.lcpServer });
        const api = { baseUrl: opts.lcpServer, token };

        let result: LcpCompany;
        if (id) {
          result = await apiRequest<LcpCompany>(
            api,
            'PUT',
            `/api/company/${id}`,
            data,
          );
        } else {
          result = await apiRequest<LcpCompany>(
            api,
            'POST',
            '/api/company',
            data,
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
