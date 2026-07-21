import * as fs from 'fs';
import * as path from 'path';
import { apiOptions, GlobalOptions } from '../core/cli-options';
import { apiUpload } from '../core/api';
import { EntityRefOpts, resolveKnowledgeScopePath } from '../core/entity-ref';
import { runCommand } from '../core/run-command';
import { resolveToken } from '../auth/token';

interface DocumentSummary {
  key: string;
  name: string;
  size: number;
  lastModified: string;
}

/** Extensions the server converts to OKF Markdown — kept in sync with `knowledge-conversion.ts`'s `SUPPORTED_EXTENSIONS`. */
const SUPPORTED_EXTENSIONS = [
  '.md',
  '.txt',
  '.html',
  '.pdf',
  '.docx',
  '.csv',
  '.json',
  '.yaml',
];

/**
 * Checks that a file's extension is one the server can convert.
 *
 * This is a fast, offline pre-check so an obviously-unsupported file fails
 * before any network call; the server performs the real conversion and OKF
 * validation authoritatively on write.
 *
 * Returns a validation error string, or null when the extension is supported.
 */
export function validateSupportedFileType(filename: string): string | null {
  const ext = path.extname(filename).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.includes(ext)) {
    return `${filename}: unsupported file type — must be one of ${SUPPORTED_EXTENSIONS.join(', ')}`;
  }
  return null;
}

/**
 * Uploads (or overwrites) a single document into a role's knowledge base, or
 * a company's shared knowledge. Accepts any of `SUPPORTED_EXTENSIONS`; the
 * server converts it to OKF Markdown and re-indexes its RAG chunks on
 * success.
 *
 * stdout: JSON `{ key, name, size, lastModified }` for the stored document.
 */
export function storeKnowledgeAction(
  opts: GlobalOptions,
  cmdOpts: EntityRefOpts & { source: string; target?: string },
): Promise<void> {
  return runCommand(async () => {
    const resolved = path.resolve(cmdOpts.source);
    if (!fs.existsSync(resolved)) {
      process.stderr.write(`Error: file not found: ${resolved}\n`);
      process.exit(1);
    }
    const content = fs.readFileSync(resolved);
    const filename = cmdOpts.target ?? path.basename(resolved);

    const error = validateSupportedFileType(filename);
    if (error) {
      process.stderr.write(
        `Validation failed — file was not uploaded:\n  ${error}\n`,
      );
      process.exit(1);
    }

    const token = await resolveToken({ ...opts, baseUrl: opts.lcpServer });
    const api = apiOptions(opts, token);
    const scopePath = await resolveKnowledgeScopePath(api, cmdOpts);

    process.stderr.write(`Uploading ${filename}...\n`);
    const doc = await apiUpload<DocumentSummary>(
      api,
      `/api/${scopePath}/knowledge`,
      filename,
      content,
      'text/markdown',
    );
    process.stderr.write(`  ✓ ${doc.key} (${doc.size} bytes)\n`);
    process.stdout.write(JSON.stringify(doc, null, 2) + '\n');
  });
}
