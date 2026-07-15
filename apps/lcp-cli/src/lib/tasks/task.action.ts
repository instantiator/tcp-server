import * as fs from 'fs';
import * as path from 'path';
import type { LcpAssignment, LcpTask } from '@lcp/shared';
import { apiOptions, GlobalOptions } from '../core/cli-options';
import { apiRequest, apiUpload } from '../core/api';
import { resolveRoleIdFrom } from '../core/entity-ref';
import { runCommand } from '../core/run-command';
import { resolveToken } from '../auth/token';

/**
 * Creates a task, uploads any given material files, and optionally starts it.
 *
 * `--company` accepts a UUID or a slug directly. `--planner-role` accepts
 * `--planner-role`/`--planner-role-id`/`--planner-role-slug` — a slug is
 * scoped to the resolved company (role slugs are only unique within a
 * company); see {@link resolveRoleIdFrom}.
 *
 * stdout: the created (or started) task as JSON.
 */
export function createTaskAction(
  opts: GlobalOptions,
  cmdOpts: {
    company: string;
    request: string;
    plannerRole?: string;
    plannerRoleId?: string;
    plannerRoleSlug?: string;
    materials?: string[];
    expected?: string[];
    start?: boolean;
  },
): Promise<void> {
  return runCommand(async () => {
    const token = await resolveToken({ ...opts, baseUrl: opts.lcpServer });
    const api = apiOptions(opts, token);

    const company = await apiRequest<{ id: string }>(
      api,
      'GET',
      `/api/company/${cmdOpts.company}`,
    );
    const plannerRoleGiven = Boolean(
      cmdOpts.plannerRole || cmdOpts.plannerRoleId || cmdOpts.plannerRoleSlug,
    );
    const plannerRoleId = plannerRoleGiven
      ? await resolveRoleIdFrom(
          api,
          {
            id: cmdOpts.plannerRoleId,
            slug: cmdOpts.plannerRoleSlug,
            value: cmdOpts.plannerRole,
          },
          { id: company.id },
          'planner-role',
        )
      : undefined;
    const expected = (cmdOpts.expected ?? []).map((filename) => ({
      type: 'task-completed-path' as const,
      value: filename,
    }));

    let task = await apiRequest<LcpTask>(api, 'POST', '/api/task', {
      companyId: company.id,
      request: cmdOpts.request,
      ...(plannerRoleId ? { plannerRoleId } : {}),
      ...(expected.length > 0 ? { expected } : {}),
    });

    for (const materialPath of cmdOpts.materials ?? []) {
      const resolved = path.resolve(materialPath);
      if (!fs.existsSync(resolved)) {
        process.stderr.write(`Error: file not found: ${resolved}\n`);
        process.exit(1);
        return;
      }
      const content = fs.readFileSync(resolved);
      const filename = path.basename(resolved);
      process.stderr.write(`Uploading material ${filename}...\n`);
      await apiUpload(api, `/api/task/${task.id}/materials`, filename, content);
    }

    if (cmdOpts.start) {
      process.stderr.write(`Starting task ${task.id}...\n`);
      task = await apiRequest<LcpTask>(
        api,
        'POST',
        `/api/task/${task.id}/start`,
      );
    }

    process.stdout.write(JSON.stringify(task, null, 2) + '\n');
  });
}

/** Lists a company's tasks. stdout: `LcpTask[]` as JSON. */
export function listTasksAction(
  opts: GlobalOptions,
  cmdOpts: { company?: string; companyId?: string; companySlug?: string },
): Promise<void> {
  return runCommand(async () => {
    const token = await resolveToken({ ...opts, baseUrl: opts.lcpServer });
    const api = apiOptions(opts, token);

    const companyIdentifier =
      cmdOpts.companyId ?? cmdOpts.companySlug ?? cmdOpts.company!;
    const company = await apiRequest<{ id: string }>(
      api,
      'GET',
      `/api/company/${companyIdentifier}`,
    );
    const tasks = await apiRequest<LcpTask[]>(
      api,
      'GET',
      `/api/task?companyId=${company.id}`,
    );
    process.stdout.write(JSON.stringify(tasks, null, 2) + '\n');
  });
}

/** Retrieves a task and its assignments. stdout: `{ task, assignments }` as JSON. */
export function getTaskAction(
  opts: GlobalOptions,
  cmdOpts: { taskId: string },
): Promise<void> {
  return runCommand(async () => {
    const token = await resolveToken({ ...opts, baseUrl: opts.lcpServer });
    const api = apiOptions(opts, token);

    const result = await apiRequest<{
      task: LcpTask;
      assignments: LcpAssignment[];
    }>(api, 'GET', `/api/task/${cmdOpts.taskId}`);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  });
}

/** Cancels a task. stdout: the cancelled task as JSON. */
export function cancelTaskAction(
  opts: GlobalOptions,
  cmdOpts: { taskId: string },
): Promise<void> {
  return runCommand(async () => {
    const token = await resolveToken({ ...opts, baseUrl: opts.lcpServer });
    const api = apiOptions(opts, token);

    const task = await apiRequest<LcpTask>(
      api,
      'POST',
      `/api/task/${cmdOpts.taskId}/cancel`,
    );
    process.stdout.write(JSON.stringify(task, null, 2) + '\n');
  });
}
