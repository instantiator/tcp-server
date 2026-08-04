import type { TcpCompany } from '@tcp/shared';
import { apiOptions, GlobalOptions } from '../core/cli-options';
import { apiRequest } from '../core/api';
import { confirmAction } from '../core/confirm';
import { EntityRefOpts } from '../core/entity-ref';
import { readJsonBody } from '../core/read-json-body';
import { runCommand } from '../core/run-command';
import { resolveToken } from '../auth/token';

interface CompanySummary {
  id: string;
  slug: string;
  name: string;
  description: string;
}

/**
 * Lists all companies from the TCP server and writes them to stdout as JSON.
 *
 * Sends `?all=true` because the CLI administers the system: `GET /api/company`
 * now defaults to the caller's own memberships for the web UI (ADR-023), and
 * an operator inspecting a deployment needs the wider view.
 */
export function listCompaniesAction(opts: GlobalOptions): Promise<void> {
  return runCommand(async () => {
    const token = await resolveToken({ ...opts, baseUrl: opts.tcpServer });
    const companies = await apiRequest<CompanySummary[]>(
      apiOptions(opts, token),
      'GET',
      '/api/company?all=true',
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
  cmdOpts: EntityRefOpts & { input?: string },
): Promise<void> {
  return runCommand(async () => {
    const data = await readJsonBody(cmdOpts);
    const bodyId = typeof data['id'] === 'string' ? data['id'] : undefined;

    const token = await resolveToken({ ...opts, baseUrl: opts.tcpServer });
    const api = apiOptions(opts, token);

    // `/api/company/:id` accepts a UUID or a slug directly, so whichever
    // identifier is given (flag takes precedence over the body's id) is
    // passed straight through as the path segment.
    const identifier =
      cmdOpts.companyId ?? cmdOpts.companySlug ?? cmdOpts.company ?? bodyId;
    const result = identifier
      ? await apiRequest<TcpCompany>(
          api,
          'PUT',
          `/api/company/${identifier}`,
          data,
        )
      : await apiRequest<TcpCompany>(api, 'POST', '/api/company', data);
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
  cmdOpts: EntityRefOpts & { force?: boolean },
): Promise<void> {
  return runCommand(async () => {
    const identifier =
      cmdOpts.companyId ?? cmdOpts.companySlug ?? cmdOpts.company;
    if (!identifier) {
      process.stderr.write(
        'Error: provide --company, --company-id, or --company-slug\n',
      );
      process.exit(1);
      return;
    }

    const token = await resolveToken({ ...opts, baseUrl: opts.tcpServer });
    const api = apiOptions(opts, token);

    const company = await apiRequest<TcpCompany | null>(
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
