/** How a stored file can be previewed in the browser, if at all. */
export type PreviewKind =
  'markdown' | 'csv' | 'text' | 'image' | 'pdf' | 'none' | 'tooLarge';

/** The biggest markdown, CSV or text file that is read into the page. */
export const TEXT_PREVIEW_MAX_BYTES = 1024 * 1024;

/** The biggest image or PDF that is shown. */
export const MEDIA_PREVIEW_MAX_BYTES = 25 * 1024 * 1024;

const EXTENSION_KINDS: Readonly<Record<string, PreviewKind>> = {
  md: 'markdown',
  markdown: 'markdown',
  csv: 'csv',
  txt: 'text',
  json: 'text',
  jsonl: 'text',
  yaml: 'text',
  yml: 'text',
  xml: 'text',
  log: 'text',
  html: 'text',
  htm: 'text',
  ini: 'text',
  toml: 'text',
  ts: 'text',
  js: 'text',
  css: 'text',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  avif: 'image',
  svg: 'image',
  pdf: 'pdf',
};

const MIME_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
};

/** The lower-cased text after the last dot; empty for `.env` or no dot. */
const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
};

/** What preview a file gets, judged by its extension and size. */
export function previewKind(name: string, size: number): PreviewKind {
  const kind = EXTENSION_KINDS[extensionOf(name)] ?? 'none';
  if (kind === 'none') return kind;
  const media = kind === 'image' || kind === 'pdf';
  const cap = media ? MEDIA_PREVIEW_MAX_BYTES : TEXT_PREVIEW_MAX_BYTES;
  return size > cap ? 'tooLarge' : kind;
}

/** The content type an image or PDF needs to display from a blob, if known. */
export function mimeFor(name: string): string | undefined {
  return MIME_TYPES[extensionOf(name)];
}
