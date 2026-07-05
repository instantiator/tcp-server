import type { LcpCompany } from '@lcp/shared';
import { apiOptions, GlobalOptions } from '../core/cli-options';
import { apiRequest } from '../core/api';
import { readStdin } from '../core/stdin';
import { runCommand } from '../core/run-command';
import { resolveToken } from '../auth/token';

interface CompanySummary {
  id: string;
  name: string;
}

/** Lists all companies from the LCP server and writes them to stdout as JSON. */
export function listCompaniesAction(opts: GlobalOptions): Promise<void> {
  return runCommand(async () => {
    const token = await resolveToken({ ...opts, baseUrl: opts.lcpServer });
    const companies = await apiRequest<CompanySummary[]>(
      apiOptions(opts, token),
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
  });
}

/** Creates or updates a company from JSON (`--input` or stdin). */
export function setCompanyAction(
  opts: GlobalOptions,
  cmdOpts: { input?: string },
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

    const token = await resolveToken({ ...opts, baseUrl: opts.lcpServer });
    const api = apiOptions(opts, token);

    const result = id
      ? await apiRequest<LcpCompany>(api, 'PUT', `/api/company/${id}`, data)
      : await apiRequest<LcpCompany>(api, 'POST', '/api/company', data);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  });
}
