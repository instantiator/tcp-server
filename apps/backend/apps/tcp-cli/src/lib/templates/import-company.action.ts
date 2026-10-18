import * as fs from 'fs';
import * as path from 'path';
import { zipSync } from 'fflate';
import { apiOptions, GlobalOptions } from '../core/cli-options';
import { apiUpload } from '../core/api';
import { runCommand } from '../core/run-command';
import { resolveToken } from '../auth/token';

/** The flags `import-company` accepts (commander turns `--no-role-models` into `roleModels: false`). */
export interface ImportCompanyOpts {
  template?: string;
  slug?: string;
  name?: string;
  llmConfig?: string;
  roleModels?: boolean;
  replace?: boolean;
  preview?: boolean;
}

/** The part of the preview response the CLI reads. */
interface TemplatePreview {
  roles: { slug: string }[];
}

/** Files that are never part of a template, however the directory was browsed. */
const IGNORED_FILES = new Set(['.DS_Store']);

/** Zips a template directory in memory, keeping paths relative to it with `/` separators. */
export function zipDirectory(dir: string): Buffer {
  const files: Record<string, Uint8Array> = {};
  const walk = (current: string, prefix: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (IGNORED_FILES.has(entry.name)) continue;
      const full = path.join(current, entry.name);
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(full, name);
      else if (entry.isFile()) files[name] = fs.readFileSync(full);
    }
  };
  walk(dir, '');
  return Buffer.from(zipSync(files));
}

/** Reads `<path>` as a template: a `.zip` as it is, a directory zipped in memory. */
function loadTemplateZip(source: string): { filename: string; data: Buffer } {
  const resolved = path.resolve(source);
  if (!fs.existsSync(resolved)) throw new Error(`Not found: ${resolved}`);
  if (fs.statSync(resolved).isDirectory()) {
    return {
      filename: `${path.basename(resolved)}.zip`,
      data: zipDirectory(resolved),
    };
  }
  return { filename: path.basename(resolved), data: fs.readFileSync(resolved) };
}

/** Parses `--llm-config`; the literal `null` is valid JSON and clears the model. */
function parseLlmConfig(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('--llm-config must be JSON (or the word null)');
  }
}

/**
 * Creates a company from a template: a `.zip`, a template directory, or a
 * gallery template (`--template <sourceId/name>`). With `--preview` it prints
 * what the import would create and imports nothing.
 *
 * stdout: the preview, or the created company, as JSON.
 */
export function importCompanyAction(
  opts: GlobalOptions,
  source: string | undefined,
  cmdOpts: ImportCompanyOpts,
): Promise<void> {
  return runCommand(async () => {
    if (!source === !cmdOpts.template) {
      throw new Error('Give either a path or --template <sourceId/name>');
    }
    const upload = source
      ? loadTemplateZip(source)
      : { filename: 'template.zip', data: null };
    const sourceFields: Record<string, string> = cmdOpts.template
      ? { template: cmdOpts.template }
      : {};

    const token = await resolveToken({ ...opts, baseUrl: opts.tcpServer });
    const api = apiOptions(opts, token);
    const send = <T>(route: string, fields: Record<string, string>) =>
      apiUpload<T>(
        api,
        route,
        upload.filename,
        upload.data,
        'application/zip',
        fields,
      );

    const noRoleModels = cmdOpts.roleModels === false;
    // The preview is only needed to print, or to learn the role slugs.
    const preview =
      cmdOpts.preview || noRoleModels
        ? await send<TemplatePreview>(
            '/api/company/import/preview',
            sourceFields,
          )
        : undefined;
    if (cmdOpts.preview) {
      process.stdout.write(JSON.stringify(preview, null, 2) + '\n');
      return;
    }

    const options: Record<string, unknown> = {};
    if (cmdOpts.slug) options['slug'] = cmdOpts.slug;
    if (cmdOpts.name) options['name'] = cmdOpts.name;
    if (cmdOpts.llmConfig !== undefined) {
      options['llmConfig'] = parseLlmConfig(cmdOpts.llmConfig);
    }
    if (preview && noRoleModels) {
      options['roleModels'] = Object.fromEntries(
        preview.roles.map((role) => [role.slug, false]),
      );
    }
    if (cmdOpts.replace) options['replace'] = true;

    const company = await send<unknown>('/api/company/import', {
      ...sourceFields,
      options: JSON.stringify(options),
    });
    process.stdout.write(JSON.stringify(company, null, 2) + '\n');
  });
}
