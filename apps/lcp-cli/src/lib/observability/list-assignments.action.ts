import type { LcpAssignment } from '@lcp/shared';
import { apiOptions, GlobalOptions } from '../core/cli-options';
import { apiRequest } from '../core/api';
import {
  EntityRefOpts,
  resolveCompanyId,
  resolveRoleIdFrom,
} from '../core/entity-ref';
import { runCommand } from '../core/run-command';
import { resolveToken } from '../auth/token';
import { parseFilters } from './filters';

export interface ListAssignmentsCmdOpts extends EntityRefOpts {
  taskId?: string;
  /** Repeatable `--filter key=value`; recognised keys: status, task, role. */
  filter?: string[];
}

/**
 * Lists assignments for a task (`--task-id`) or company
 * (`--company`/`--company-id`/`--company-slug`), optionally narrowed by
 * `--filter status=<status>`, `--filter task=<task-id>` (overrides
 * `--task-id`), `--filter task=null` (orphan assignments), or
 * `--filter role=<slug-or-id>`.
 *
 * stdout: `LcpAssignment[]` as JSON.
 */
export function listAssignmentsAction(
  opts: GlobalOptions,
  cmdOpts: ListAssignmentsCmdOpts,
): Promise<void> {
  return runCommand(async () => {
    const token = await resolveToken({ ...opts, baseUrl: opts.lcpServer });
    const api = apiOptions(opts, token);
    const filters = parseFilters(cmdOpts.filter);

    const companyGiven = Boolean(
      cmdOpts.company || cmdOpts.companyId || cmdOpts.companySlug,
    );

    const qs = new URLSearchParams();
    if (cmdOpts.taskId) qs.set('taskId', cmdOpts.taskId);
    if (companyGiven) qs.set('companyId', await resolveCompanyId(api, cmdOpts));
    if (filters.task !== undefined) qs.set('taskId', filters.task);
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
    if (filters.status) qs.set('status', filters.status);

    if (!qs.has('companyId') && !qs.has('taskId')) {
      process.stderr.write(
        'Error: pass --task-id, a company (--company/--company-id/--company-slug), or --filter task=<id>\n',
      );
      process.exit(1);
      return;
    }

    const assignments = await apiRequest<LcpAssignment[]>(
      api,
      'GET',
      `/api/assignment?${qs.toString()}`,
    );
    process.stdout.write(JSON.stringify(assignments, null, 2) + '\n');
  });
}
