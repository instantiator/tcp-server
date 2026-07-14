import * as fs from 'fs';
import * as path from 'path';
import { validateOkf } from '@lcp/shared';
import { apiOptions, GlobalOptions } from '../core/cli-options';
import { apiUpload } from '../core/api';
import {
  KnowledgeScopeOpts,
  resolveKnowledgeScopePath,
} from '../core/resolve-knowledge-scope';
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
 * - Must have valid YAML front-matter with a non-empty `title` field
 *   (delegates to the shared `validateOkf` — see `libs/lcp-shared/src/storage/validation`).
 *
 * This is a fast, offline pre-check so an obviously-invalid file fails before
 * any network call; the server enforces the same rule authoritatively on
 * write, since a user could also write to storage without going through the CLI.
 *
 * Returns a validation error string, or null when valid.
 */
export function validateOkfDocument(
  filename: string,
  content: string,
): string | null {
  if (path.extname(filename).toLowerCase() !== '.md') {
    return `${filename}: must be a Markdown (.md) file`;
  }
  const result = validateOkf(content);
  if (!result.valid) {
    return `${filename}: ${result.errors[0].llmHint}`;
  }
  return null;
}

/**
 * Uploads (or overwrites) a single OKF Markdown document into a role's
 * knowledge base, or a company's shared knowledge.
 *
 * The file is validated before upload (`.md` extension + front-matter with
 * `title`); the server re-indexes its RAG chunks on success.
 *
 * stdout: JSON `{ key, name, size, lastModified }` for the stored document.
 */
export function storeKnowledgeAction(
  opts: GlobalOptions,
  cmdOpts: KnowledgeScopeOpts & { source: string; target?: string },
): Promise<void> {
  return runCommand(async () => {
    const resolved = path.resolve(cmdOpts.source);
    if (!fs.existsSync(resolved)) {
      process.stderr.write(`Error: file not found: ${resolved}\n`);
      process.exit(1);
    }
    const content = fs.readFileSync(resolved);
    const filename = cmdOpts.target ?? path.basename(resolved);

    const error = validateOkfDocument(filename, content.toString('utf-8'));
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
