import type { LcpAgent } from '@lcp/shared';
import { apiOptions, GlobalOptions } from '../core/cli-options';
import { apiRequest } from '../core/api';
import {
  EntityRefOpts,
  resolveCompanyId,
  resolveRoleId,
  resolveRoleIdFrom,
} from '../core/entity-ref';
import { runCommand } from '../core/run-command';
import { resolveToken } from '../auth/token';
import { parseFilters } from './filters';

export interface ListAgentsCmdOpts extends EntityRefOpts {
  /** Repeatable `--filter key=value`; recognised keys: status, role, assignment. */
  filter?: string[];
}

/**
 * Lists agents for a role (`--role`/`--role-id`/`--role-slug`) or company
 * (`--company`/`--company-id`/`--company-slug`), optionally narrowed by
 * `--filter status=<status>` (default: currently active agents — see
 * `DbService.listAgents`), `--filter role=<slug-or-id>` (overrides the
 * top-level role scope), or `--filter assignment=<assignment-id>`.
 *
 * stdout: `LcpAgent[]` as JSON.
 */
export function listAgentsAction(
  opts: GlobalOptions,
  cmdOpts: ListAgentsCmdOpts,
): Promise<void> {
  return runCommand(async () => {
    const token = await resolveToken({ ...opts, baseUrl: opts.lcpServer });
    const api = apiOptions(opts, token);
    const filters = parseFilters(cmdOpts.filter);

    const roleGiven = Boolean(
      cmdOpts.role || cmdOpts.roleId || cmdOpts.roleSlug,
    );
    const companyGiven = Boolean(
      cmdOpts.company || cmdOpts.companyId || cmdOpts.companySlug,
    );

    const qs = new URLSearchParams();
    if (companyGiven) qs.set('companyId', await resolveCompanyId(api, cmdOpts));
    if (roleGiven) qs.set('roleId', await resolveRoleId(api, cmdOpts));
    if (filters.role) {
      qs.set(
        'roleId',
        await resolveRoleIdFrom(
          api,
          { value: filters.role },
          {
            id: cmdOpts.companyId,
            slug: cmdOpts.companySlug,
            value: cmdOpts.company,
          },
        ),
      );
    }
    if (filters.assignment) qs.set('assignmentId', filters.assignment);
    if (filters.status) qs.set('status', filters.status);

    if (!qs.has('companyId') && !qs.has('roleId') && !qs.has('assignmentId')) {
      process.stderr.write(
        'Error: pass a role or company (--role/--company, any variant) or --filter assignment=<id>\n',
      );
      process.exit(1);
      return;
    }

    const agents = await apiRequest<LcpAgent[]>(
      api,
      'GET',
      `/api/agent?${qs.toString()}`,
    );
    process.stdout.write(JSON.stringify(agents, null, 2) + '\n');
  });
}
