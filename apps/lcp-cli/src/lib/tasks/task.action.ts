import * as fs from 'fs';
import * as path from 'path';
import type { LcpAssignment, LcpTask } from '@lcp/shared';
import { apiOptions, GlobalOptions } from '../core/cli-options';
import { ApiOptions, apiRequest, apiUpload } from '../core/api';
import { runCommand } from '../core/run-command';
import { resolveToken } from '../auth/token';

/** Matches a canonical UUID (case-insensitive). */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Resolves a role given as either a UUID or a slug scoped to `companyId` (see `resolveKnowledgeScopePath`'s `--role` handling for the same pattern). */
async function resolveRoleId(
  api: ApiOptions,
  companyId: string,
  roleFlag: string,
): Promise<string> {
  if (UUID_RE.test(roleFlag)) return roleFlag;
  const role = await apiRequest<{ id: string }>(
    api,
    'GET',
    `/api/company/${companyId}/roles/by-slug/${roleFlag}`,
  );
  return role.id;
}

/**
 * Creates a task, uploads any given material files, and optionally starts it.
 *
 * `--company`/`--planner-role` accept a UUID or a slug directly (the latter
 * scoped to the resolved company for `--planner-role`, since role slugs are
 * only unique within a company).
 *
 * stdout: the created (or started) task as JSON.
 */
export function createTaskAction(
  opts: GlobalOptions,
  cmdOpts: {
    company: string;
    request: string;
    plannerRole?: string;
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
    const plannerRoleId = cmdOpts.plannerRole
      ? await resolveRoleId(api, company.id, cmdOpts.plannerRole)
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
  cmdOpts: { company: string },
): Promise<void> {
  return runCommand(async () => {
    const token = await resolveToken({ ...opts, baseUrl: opts.lcpServer });
    const api = apiOptions(opts, token);

    const company = await apiRequest<{ id: string }>(
      api,
      'GET',
      `/api/company/${cmdOpts.company}`,
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
