import * as fs from 'fs';
import * as path from 'path';
import { load } from 'js-yaml';
import { apiOptions, GlobalOptions } from '../core/cli-options';
import { apiUpload } from '../core/api';
import { RoleIdentifierOpts, resolveRoleId } from '../core/resolve-identifiers';
import { runCommand } from '../core/run-command';
import { resolveToken } from '../auth/token';

interface DocumentSummary {
  key: string;
  name: string;
  size: number;
  lastModified: string;
}

/**
 * Validates that a file is an OKF document:
 * - Must have a `.md` extension.
 * - Must have valid YAML front-matter with a non-empty `title` field.
 *
 * Returns a validation error string, or null when valid.
 */
export function validateOkfDocument(
  filePath: string,
  content: string,
): string | null {
  if (path.extname(filePath).toLowerCase() !== '.md') {
    return `${filePath}: must be a Markdown (.md) file`;
  }
  let data: Record<string, unknown>;
  try {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    data = match ? ((load(match[1]) as Record<string, unknown>) ?? {}) : {};
  } catch {
    return `${filePath}: failed to parse YAML front-matter`;
  }
  if (
    !data['title'] ||
    typeof data['title'] !== 'string' ||
    !data['title'].trim()
  ) {
    return `${filePath}: front-matter must include a non-empty 'title' field`;
  }
  return null;
}

/** Reads and validates every source file up front; exits(1) on the first problem found. */
function readAndValidateFiles(
  paths: string[],
): Array<{ filePath: string; content: Buffer }> {
  const files: Array<{ filePath: string; content: Buffer }> = [];
  for (const src of paths) {
    const resolved = path.resolve(src);
    if (!fs.existsSync(resolved)) {
      process.stderr.write(`Error: file not found: ${resolved}\n`);
      process.exit(1);
    }
    files.push({ filePath: resolved, content: fs.readFileSync(resolved) });
  }

  const errors = files
    .map(({ filePath, content }) =>
      validateOkfDocument(filePath, content.toString('utf-8')),
    )
    .filter((err): err is string => err !== null);
  if (errors.length > 0) {
    process.stderr.write('Validation failed — no files were uploaded:\n');
    for (const e of errors) process.stderr.write(`  ${e}\n`);
    process.exit(1);
  }

  return files;
}

/**
 * Uploads OKF Markdown documents to a role's knowledge base.
 *
 * Files are validated first (`.md` extension + front-matter with `title`).
 * If any file fails validation, none are uploaded.
 *
 * Each file is uploaded individually; the server stores it in MinIO and
 * triggers RAG re-indexing for that document.
 *
 * stdout: JSON array of `{ key, name, size, lastModified }` for each
 * successfully uploaded document.
 */
export function storeRoleDocumentsAction(
  opts: GlobalOptions,
  cmdOpts: RoleIdentifierOpts & { src: string[] },
): Promise<void> {
  return runCommand(async () => {
    const files = readAndValidateFiles(cmdOpts.src);

    const token = await resolveToken({ ...opts, baseUrl: opts.lcpServer });
    const api = apiOptions(opts, token);
    const roleId = await resolveRoleId(api, cmdOpts);
    const results: DocumentSummary[] = [];

    for (const { filePath, content } of files) {
      const filename = path.basename(filePath);
      process.stderr.write(`Uploading ${filename}...\n`);
      const doc = await apiUpload<DocumentSummary>(
        api,
        `/api/role/${roleId}/documents`,
        filename,
        content,
      );
      results.push(doc);
      process.stderr.write(`  ✓ ${doc.key} (${doc.size} bytes)\n`);
    }

    process.stdout.write(JSON.stringify(results, null, 2) + '\n');
  });
}
