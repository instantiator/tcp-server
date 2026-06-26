import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import { load } from 'js-yaml';
import { apiUpload } from '../lib/api';
import { resolveToken } from '../lib/auth';

interface DocumentSummary {
  key: string;
  name: string;
  size: number;
  lastModified: string;
}

/**
 * @internal Exported for testing only.
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
export function registerStoreRoleDocuments(program: Command): void {
  program
    .command('store-role-documents')
    .description('Upload OKF Markdown documents to a role knowledge base')
    .requiredOption('-r, --role-id <uuid>', 'Role UUID')
    .requiredOption(
      '-s, --src <paths...>',
      'One or more Markdown file paths to upload',
    )
    .action(async (cmdOpts: { roleId: string; src: string[] }) => {
      const opts = program.opts<{
        lcpServer: string;
        accessToken?: string;
        accessTokenEnvVar?: string;
        username?: string;
        password?: string;
      }>();

      try {
        // --- Expand and read files ---
        const files: Array<{ filePath: string; content: Buffer }> = [];
        for (const src of cmdOpts.src) {
          const resolved = path.resolve(src);
          if (!fs.existsSync(resolved)) {
            process.stderr.write(`Error: file not found: ${resolved}\n`);
            process.exit(1);
          }
          files.push({
            filePath: resolved,
            content: fs.readFileSync(resolved),
          });
        }

        // --- Validate all files before uploading any ---
        const errors: string[] = [];
        for (const { filePath, content } of files) {
          const err = validateOkfDocument(filePath, content.toString('utf-8'));
          if (err) errors.push(err);
        }
        if (errors.length > 0) {
          process.stderr.write('Validation failed — no files were uploaded:\n');
          for (const e of errors) process.stderr.write(`  ${e}\n`);
          process.exit(1);
        }

        // --- Upload ---
        const token = await resolveToken({ ...opts, baseUrl: opts.lcpServer });
        const results: DocumentSummary[] = [];

        for (const { filePath, content } of files) {
          const filename = path.basename(filePath);
          process.stderr.write(`Uploading ${filename}...\n`);
          const doc = await apiUpload<DocumentSummary>(
            { baseUrl: opts.lcpServer, token },
            `/api/role/${cmdOpts.roleId}/documents`,
            filename,
            content,
          );
          results.push(doc);
          process.stderr.write(`  ✓ ${doc.key} (${doc.size} bytes)\n`);
        }

        process.stdout.write(JSON.stringify(results, null, 2) + '\n');
      } catch (err) {
        process.stderr.write(
          `Error: ${String(err instanceof Error ? err.message : err)}\n`,
        );
        process.exit(1);
      }
    });
}
