import type { LcpCompany } from '@lcp/shared';
import { apiOptions, GlobalOptions } from '../core/cli-options';
import { apiRequest } from '../core/api';
import { confirmAction } from '../core/confirm';
import { CompanyIdentifierOpts } from '../core/resolve-identifiers';
import { readStdin } from '../core/stdin';
import { runCommand } from '../core/run-command';
import { resolveToken } from '../auth/token';

interface CompanySummary {
  id: string;
  slug: string;
  name: string;
  description: string;
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
        companies.map(({ id, slug, name, description }) => ({
          id,
          slug,
          name,
          description,
        })),
        null,
        2,
      ) + '\n',
    );
  });
}

/** Creates or updates a company from JSON (`--input` or stdin). */
export function setCompanyAction(
  opts: GlobalOptions,
  cmdOpts: { companyId?: string; companySlug?: string; input?: string },
): Promise<void> {
  return runCommand(async () => {
    const raw = cmdOpts.input ?? (await readStdin());
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      process.stderr.write('Error: input must be a JSON object\n');
      process.exit(1);
    }
    const data = parsed as Record<string, unknown>;
    const bodyId = typeof data['id'] === 'string' ? data['id'] : undefined;

    const token = await resolveToken({ ...opts, baseUrl: opts.lcpServer });
    const api = apiOptions(opts, token);

    // `/api/company/:id` accepts a UUID or a slug directly, so whichever
    // identifier is given (flag takes precedence over the body's id) is
    // passed straight through as the path segment.
    const identifier = cmdOpts.companyId ?? cmdOpts.companySlug ?? bodyId;
    const result = identifier
      ? await apiRequest<LcpCompany>(
          api,
          'PUT',
          `/api/company/${identifier}`,
          data,
        )
      : await apiRequest<LcpCompany>(api, 'POST', '/api/company', data);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  });
}

/**
 * Deletes a company (and, via cascade, its roles, agents, audit events,
 * conversations, knowledge chunks, episodic memory, and company users).
 *
 * Checks the company exists first; unless `--force` is given, asks for
 * y/n confirmation before deleting.
 */
export function deleteCompanyAction(
  opts: GlobalOptions,
  cmdOpts: CompanyIdentifierOpts & { force?: boolean },
): Promise<void> {
  return runCommand(async () => {
    const identifier = cmdOpts.companyId ?? cmdOpts.companySlug;
    if (!identifier) {
      process.stderr.write(
        'Error: provide either --company-id or --company-slug\n',
      );
      process.exit(1);
      return;
    }

    const token = await resolveToken({ ...opts, baseUrl: opts.lcpServer });
    const api = apiOptions(opts, token);

    const company = await apiRequest<LcpCompany | null>(
      api,
      'GET',
      `/api/company/${identifier}`,
    );
    if (!company?.id) {
      process.stderr.write(`Company ${identifier} not found\n`);
      process.exit(1);
      return;
    }

    if (!cmdOpts.force) {
      const confirmed = await confirmAction(
        `Delete company "${company.name}" (${company.slug}) and everything in it?`,
      );
      if (!confirmed) {
        process.stderr.write('Aborted.\n');
        return;
      }
    }

    await apiRequest(api, 'DELETE', `/api/company/${company.id}`);
    process.stdout.write(`Deleted company ${company.id} (${company.slug})\n`);
  });
}
