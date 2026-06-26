import { Command } from 'commander';
import { apiRequest } from '../lib/api';
import { resolveToken } from '../lib/auth';

interface Conversation {
  slug: string;
  roleName: string;
  question: string;
  status: string;
  createdAt: string;
}

/** Formats a list of conversations as a padded text table. */
function formatTable(rows: Conversation[]): string {
  if (rows.length === 0) return 'No open queries.\n';
  const slugW = Math.max(4, ...rows.map((r) => r.slug.length));
  const roleW = Math.max(4, ...rows.map((r) => r.roleName.length));
  const header =
    'SLUG'.padEnd(slugW) + '  ' + 'ROLE'.padEnd(roleW) + '  ' + 'QUESTION';
  const divider =
    '-'.repeat(slugW) + '  ' + '-'.repeat(roleW) + '  ' + '-'.repeat(40);
  const body = rows.map(
    (r) =>
      r.slug.padEnd(slugW) +
      '  ' +
      r.roleName.padEnd(roleW) +
      '  ' +
      r.question.slice(0, 120).replace(/\n/g, ' '),
  );
  return [header, divider, ...body].join('\n') + '\n';
}

/**
 * Lists open agent-to-human query conversations.
 *
 * stdout: table (default), JSON, or CSV depending on `--format`.
 */
export function registerListOpenQueries(program: Command): void {
  program
    .command('list-open-queries')
    .description('List open agent-to-human queries awaiting a response')
    .option('-c, --company-id <uuid>', 'Filter to a specific company')
    .option(
      '-f, --format <fmt>',
      'Output format: table, json, or csv (default: table)',
      'table',
    )
    .action(async (cmdOpts: { companyId?: string; format: string }) => {
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

        const qs = new URLSearchParams({ status: 'awaiting_user' });
        if (cmdOpts.companyId) qs.set('companyId', cmdOpts.companyId);

        const rows = await apiRequest<Conversation[]>(
          api,
          'GET',
          `/api/conversation?${qs.toString()}`,
        );

        switch (cmdOpts.format) {
          case 'json':
            process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
            break;
          case 'csv': {
            process.stdout.write('slug,role,question\n');
            for (const r of rows) {
              const q = r.question.replace(/"/g, '""').replace(/\n/g, ' ');
              process.stdout.write(`"${r.slug}","${r.roleName}","${q}"\n`);
            }
            break;
          }
          default:
            process.stdout.write(formatTable(rows));
        }
      } catch (err) {
        process.stderr.write(
          `Error: ${String(err instanceof Error ? err.message : err)}\n`,
        );
        process.exit(1);
      }
    });
}
