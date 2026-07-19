import { analyzeCsv } from './analyze-csv';
import { analyzeFallback } from './analyze-fallback';
import { analyzeJson } from './analyze-json';
import { analyzeMarkdown } from './analyze-markdown';
import { analyzeTypescript } from './analyze-typescript';
import { analyzeYaml } from './analyze-yaml';

export { analyzeCsv } from './analyze-csv';
export { analyzeJson } from './analyze-json';
export { analyzeMarkdown } from './analyze-markdown';
export { analyzeYaml } from './analyze-yaml';
export { analyzeTypescript } from './analyze-typescript';
export { analyzeFallback } from './analyze-fallback';

const MIME_MAP: Record<string, string> = {
  '.json': 'application/json',
  '.jsonc': 'application/json',
  '.md': 'text/markdown',
  '.mdx': 'text/markdown',
  '.ts': 'application/typescript',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.yaml': 'application/x-yaml',
  '.yml': 'application/x-yaml',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.xml': 'application/xml',
};

/**
 * Structural analysis of file content — no LLM required. Dispatches to a
 * per-format analyzer based on file extension; falls back to a plain-text
 * line count for anything unrecognised.
 */
export function analyzeContent(
  path: string,
  content: string,
  size: number | undefined,
): Record<string, unknown> {
  const ext = path.includes('.')
    ? '.' + path.split('.').pop()!.toLowerCase()
    : '';
  const base: Record<string, unknown> = {
    path,
    size,
    contentType: MIME_MAP[ext] ?? 'application/octet-stream',
  };

  if (ext === '.json' || ext === '.jsonc')
    return analyzeJson(base, content, ext);
  if (ext === '.md' || ext === '.mdx') return analyzeMarkdown(base, content);
  if (ext === '.csv') return analyzeCsv(base, content);
  if (ext === '.yaml' || ext === '.yml') return analyzeYaml(base, content);
  if (ext === '.ts' || ext === '.js' || ext === '.mjs')
    return analyzeTypescript(base, content);
  return analyzeFallback(base, content);
}
