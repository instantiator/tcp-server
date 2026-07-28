import { apiOptions, GlobalOptions } from '../core/cli-options';
import { apiRequest } from '../core/api';
import { runCommand } from '../core/run-command';
import { resolveToken } from '../auth/token';

interface ValidationEntry {
  path: string;
  found: boolean;
  size: number;
  valid: boolean;
  errors: string[];
}

interface ValidateSharedDocumentResponse {
  query: { path: string; recursive: boolean };
  validations: ValidationEntry[];
}

/**
 * Validates one or more documents already in shared storage against the
 * same rules enforced at write time (`POST /api/storage/validate`). `path`
 * may be a specific object key or a glob pattern (`*`, `?`) — a glob
 * matching zero files is still a success.
 *
 * A non-2xx response (e.g. a specifically-named file or directory that
 * doesn't exist) throws via `apiRequest`, which `runCommand` reports as
 * `Error: ...` with exit 1. A 2xx response is printed as JSON to stdout and
 * exits 0 — even when individual `validations[].valid` entries are
 * `false`; that's a successful check that found problems, not a failed
 * request.
 */
export function validateSharedDocumentAction(
  opts: GlobalOptions,
  cmdOpts: { path: string; recursive?: boolean },
): Promise<void> {
  return runCommand(async () => {
    const token = await resolveToken({ ...opts, baseUrl: opts.tcpServer });
    const result = await apiRequest<ValidateSharedDocumentResponse>(
      apiOptions(opts, token),
      'POST',
      '/api/storage/validate',
      { path: cmdOpts.path, recursive: cmdOpts.recursive ?? false },
    );
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  });
}
