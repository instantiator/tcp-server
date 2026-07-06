import { apiOptions, GlobalOptions } from '../core/cli-options';
import { apiRequest } from '../core/api';
import { runCommand } from '../core/run-command';
import { resolveToken } from '../auth/token';

interface DocumentSummary {
  key: string;
  name: string;
}

/** Converts a simple glob pattern (`*`, `?`) to a RegExp. */
export function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .split('*')
    .map((s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\?/g, '.'))
    .join('[^/]*');
  return new RegExp(`^${escaped}$`);
}

/**
 * Removes OKF knowledge-base documents from a role by matching their names
 * against a set of patterns.
 *
 * Patterns support simple glob-style wildcards:
 *   - `*` matches any sequence of characters (excluding `/`)
 *   - `?` matches any single character
 *
 * The command first lists all documents for the role, then filters by the
 * provided patterns, and finally sends a single DELETE request with the
 * matched keys. If no documents match, the command exits cleanly without
 * making a DELETE request.
 *
 * stderr: progress messages.
 * stdout: JSON array of deleted document keys.
 */
export function removeRoleDocumentsAction(
  opts: GlobalOptions,
  cmdOpts: { roleId: string; pattern: string[] },
): Promise<void> {
  return runCommand(async () => {
    const token = await resolveToken({ ...opts, baseUrl: opts.lcpServer });
    const api = apiOptions(opts, token);

    const allDocs = await apiRequest<DocumentSummary[]>(
      api,
      'GET',
      `/api/role/${cmdOpts.roleId}/documents`,
    );

    const regexes = cmdOpts.pattern.map(globToRegex);
    const matched = allDocs.filter((d) =>
      regexes.some((re) => re.test(d.name)),
    );

    if (matched.length === 0) {
      process.stderr.write('No documents matched the given patterns.\n');
      process.stdout.write('[]\n');
      return;
    }

    process.stderr.write(`Deleting ${matched.length} document(s)...\n`);
    for (const doc of matched) {
      process.stderr.write(`  ${doc.name}\n`);
    }

    await apiRequest(api, 'DELETE', `/api/role/${cmdOpts.roleId}/documents`, {
      keys: matched.map((d) => d.key),
    });

    process.stdout.write(
      JSON.stringify(
        matched.map((d) => d.key),
        null,
        2,
      ) + '\n',
    );
  });
}
