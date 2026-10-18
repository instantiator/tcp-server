import { apiOptions, GlobalOptions } from '../core/cli-options';
import { apiRequest } from '../core/api';
import { runCommand } from '../core/run-command';
import { resolveToken } from '../auth/token';

/** Fetches `path` with a token and prints the JSON result. */
function printJson(
  opts: GlobalOptions,
  method: string,
  path: string,
  body?: unknown,
): Promise<void> {
  return runCommand(async () => {
    const token = await resolveToken({ ...opts, baseUrl: opts.tcpServer });
    const result = await apiRequest<unknown>(
      apiOptions(opts, token),
      method,
      path,
      body,
    );
    process.stdout.write(
      JSON.stringify(result ?? { ok: true }, null, 2) + '\n',
    );
  });
}

/** Prints the template gallery: every template from every source. */
export function listTemplatesAction(opts: GlobalOptions): Promise<void> {
  return printJson(opts, 'GET', '/api/template');
}

/** Prints the places the gallery reads templates from. */
export function listTemplateSourcesAction(opts: GlobalOptions): Promise<void> {
  return printJson(opts, 'GET', '/api/template-source');
}

/** Adds a public GitHub repository as a gallery source (admin only). */
export function addTemplateSourceAction(
  opts: GlobalOptions,
  name: string,
  repo: string,
  cmdOpts: { ref?: string; path?: string },
): Promise<void> {
  return printJson(opts, 'POST', '/api/template-source', {
    name,
    repo,
    ...(cmdOpts.ref ? { ref: cmdOpts.ref } : {}),
    ...(cmdOpts.path ? { path: cmdOpts.path } : {}),
  });
}

/** Removes a gallery source added with `template-source add` (admin only). */
export function removeTemplateSourceAction(
  opts: GlobalOptions,
  id: string,
): Promise<void> {
  return printJson(
    opts,
    'DELETE',
    `/api/template-source/${encodeURIComponent(id)}`,
  );
}
