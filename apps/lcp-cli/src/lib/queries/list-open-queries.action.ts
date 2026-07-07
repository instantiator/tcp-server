import { apiOptions, GlobalOptions } from '../core/cli-options';
import { apiRequest } from '../core/api';
import { resolveCompanyId } from '../core/resolve-identifiers';
import { runCommand } from '../core/run-command';
import { resolveToken } from '../auth/token';

interface Conversation {
  slug: string;
  roleName: string;
  question: string;
  status: string;
  createdAt: string;
}

/** The fields formatTable/formatCsv actually render. */
interface ConversationSummary {
  slug: string;
  roleName: string;
  question: string;
}

/** Formats a list of conversations as a padded text table. */
export function formatTable(rows: ConversationSummary[]): string {
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

/** Formats a list of conversations as CSV. */
function formatCsv(rows: ConversationSummary[]): string {
  const lines = ['slug,role,question'];
  for (const r of rows) {
    const q = r.question.replace(/"/g, '""').replace(/\n/g, ' ');
    lines.push(`"${r.slug}","${r.roleName}","${q}"`);
  }
  return lines.join('\n') + '\n';
}

/**
 * Lists open agent-to-human query conversations.
 *
 * stdout: table (default), JSON, or CSV depending on `--format`.
 */
export function listOpenQueriesAction(
  opts: GlobalOptions,
  cmdOpts: { companyId?: string; companySlug?: string; format: string },
): Promise<void> {
  return runCommand(async () => {
    const token = await resolveToken({ ...opts, baseUrl: opts.lcpServer });
    const api = apiOptions(opts, token);

    const qs = new URLSearchParams({ status: 'awaiting_user' });
    if (cmdOpts.companyId || cmdOpts.companySlug) {
      qs.set('companyId', await resolveCompanyId(api, cmdOpts));
    }

    const rows = await apiRequest<Conversation[]>(
      api,
      'GET',
      `/api/conversation?${qs.toString()}`,
    );

    switch (cmdOpts.format) {
      case 'json':
        process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
        break;
      case 'csv':
        process.stdout.write(formatCsv(rows));
        break;
      default:
        process.stdout.write(formatTable(rows));
    }
  });
}
