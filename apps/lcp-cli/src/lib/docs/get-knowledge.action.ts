import * as fs from 'fs';
import * as path from 'path';
import { apiOptions, GlobalOptions } from '../core/cli-options';
import { apiDownload } from '../core/api';
import { EntityRefOpts, resolveKnowledgeScopePath } from '../core/entity-ref';
import { runCommand } from '../core/run-command';
import { resolveToken } from '../auth/token';

/**
 * Retrieves a single OKF knowledge-base document's content, for a role or a
 * company's shared knowledge.
 *
 * stdout: the document's raw content (unless `--out` is given, in which
 * case it's written to that path and stderr reports the save location).
 */
export function getKnowledgeAction(
  opts: GlobalOptions,
  cmdOpts: EntityRefOpts & { file: string; out?: string },
): Promise<void> {
  return runCommand(async () => {
    const token = await resolveToken({ ...opts, baseUrl: opts.lcpServer });
    const api = apiOptions(opts, token);
    const scopePath = await resolveKnowledgeScopePath(api, cmdOpts);
    const { data } = await apiDownload(
      api,
      `/api/${scopePath}/knowledge/${encodeURIComponent(cmdOpts.file)}`,
    );

    if (cmdOpts.out) {
      const resolved = path.resolve(cmdOpts.out);
      fs.writeFileSync(resolved, data);
      process.stderr.write(`Saved to ${resolved}\n`);
    } else {
      process.stdout.write(data);
    }
  });
}
