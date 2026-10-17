import * as fs from 'fs';
import * as path from 'path';
import { unzipSync } from 'fflate';
import { apiOptions, GlobalOptions } from '../core/cli-options';
import { apiDownload } from '../core/api';
import { runCommand } from '../core/run-command';
import { resolveToken } from '../auth/token';

/**
 * Starts a new template: unpacks the built-in blank one (which carries the
 * format reference) into `dir`. Refuses a directory that already has files,
 * and any zip entry that would land outside `dir`.
 *
 * stdout: the files written, one per line.
 */
export function newTemplateAction(
  opts: GlobalOptions,
  dir: string,
): Promise<void> {
  return runCommand(async () => {
    const target = path.resolve(dir);
    if (fs.existsSync(target) && fs.readdirSync(target).length > 0) {
      throw new Error(`${target} already exists and is not empty`);
    }

    const token = await resolveToken({ ...opts, baseUrl: opts.tcpServer });
    const { data } = await apiDownload(
      apiOptions(opts, token),
      '/api/template/builtin/blank',
    );
    const entries = Object.entries(unzipSync(new Uint8Array(data))).filter(
      ([name]) => !name.endsWith('/'),
    );
    // Check every name before writing any, so a bad zip leaves nothing behind.
    for (const [name] of entries) {
      if (name.includes('..') || name.startsWith('/')) {
        throw new Error(`Refusing unsafe path in template: ${name}`);
      }
    }

    fs.mkdirSync(target, { recursive: true });
    for (const [name, content] of entries) {
      const file = path.join(target, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
      process.stdout.write(`${file}\n`);
    }
  });
}
