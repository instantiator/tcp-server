import * as path from 'path';
import { BadRequestException } from '@nestjs/common';
import { parseFrontMatter } from '@lcp/shared';
import { load as loadYaml, dump as dumpYaml } from 'js-yaml';
import { parse as parseCsv } from 'csv-parse/sync';
import * as cheerio from 'cheerio';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { PDFParse } from 'pdf-parse';
import * as mammoth from 'mammoth';

/** Extensions `store-knowledge` accepts; each is converted to OKF Markdown server-side. */
export const SUPPORTED_EXTENSIONS = [
  '.md',
  '.txt',
  '.html',
  '.pdf',
  '.docx',
  '.csv',
  '.json',
  '.yaml',
] as const;

/** Result of converting an uploaded file's raw bytes to a Markdown body, ahead of OKF front-matter generation (see {@link ensureOkfFrontMatter}). */
export interface ConvertedDocument {
  /** A title discovered in the source format (HTML `<title>`, a Markdown heading, existing OKF front-matter), or `null` if none was found. */
  title: string | null;
  body: string;
}

// Mirrors the leading front-matter block matched by okf-validator's own
// regex (not exported from there) — used here to detect/strip a pre-existing
// block so ensureOkfFrontMatter never double-wraps.
const FRONT_MATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;
const HEADING = /^#{1,2}\s+(.+)$/m;

const turndown = new TurndownService({ headingStyle: 'atx' }).use(gfm);

/**
 * Converts an uploaded file's raw bytes to a Markdown body, dispatching on
 * its filename extension. Does not add OKF front-matter — see
 * {@link ensureOkfFrontMatter}.
 *
 * @throws {@link BadRequestException} for an unrecognised extension, or a
 * `.csv`/`.json`/`.yaml` source that fails its own well-formedness check.
 */
export async function convertToMarkdown(
  filename: string,
  buffer: Buffer,
): Promise<ConvertedDocument> {
  switch (path.extname(filename).toLowerCase()) {
    case '.md':
      return convertMarkdown(buffer);
    case '.txt':
      return { title: null, body: buffer.toString('utf-8') };
    case '.html':
      return convertHtml(buffer);
    case '.pdf':
      return convertPdf(buffer);
    case '.docx':
      return convertDocx(buffer);
    case '.csv':
      return convertFenced(buffer, 'csv', (text) => parseCsv(text));
    case '.json':
      return convertFenced(buffer, 'json', (text) => JSON.parse(text));
    case '.yaml':
      return convertFenced(buffer, 'yaml', (text) => loadYaml(text));
    default:
      throw new BadRequestException(
        `Unsupported file type for '${filename}'. Supported extensions: ${SUPPORTED_EXTENSIONS.join(', ')}`,
      );
  }
}

/** Passes Markdown through unchanged; its own front-matter `title` (if any) wins. */
function convertMarkdown(buffer: Buffer): ConvertedDocument {
  const body = buffer.toString('utf-8');
  const title = parseFrontMatter(body)?.['title'];
  return { title: typeof title === 'string' ? title : null, body };
}

function convertHtml(buffer: Buffer): ConvertedDocument {
  const $ = cheerio.load(buffer.toString('utf-8'));
  const title = $('title').first().text().trim() || null;
  const body = turndown.turndown($.root().html() ?? '');
  return { title, body };
}

async function convertPdf(buffer: Buffer): Promise<ConvertedDocument> {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return { title: null, body: result.text };
  } finally {
    await parser.destroy();
  }
}

async function convertDocx(buffer: Buffer): Promise<ConvertedDocument> {
  // mammoth's shipped .d.ts omits `convertToMarkdown` (present at runtime,
  // absent from the typed surface) — convert to HTML and reuse the same
  // turndown pipeline as `.html` instead.
  const { value: html } = await mammoth.convertToHtml({ buffer });
  const body = turndown.turndown(html);
  const heading = HEADING.exec(body);
  return { title: heading ? heading[1].trim() : null, body };
}

/** Wraps `.csv`/`.json`/`.yaml` text in a fenced code block, after checking it actually parses. */
function convertFenced(
  buffer: Buffer,
  lang: 'csv' | 'json' | 'yaml',
  checkWellFormed: (text: string) => unknown,
): ConvertedDocument {
  const text = buffer.toString('utf-8');
  try {
    checkWellFormed(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new BadRequestException(
      `File is not valid ${lang.toUpperCase()}: ${message}`,
    );
  }
  return { title: null, body: '```' + lang + '\n' + text + '\n```\n' };
}

/**
 * Generates OKF front-matter for a converted document, choosing a title in
 * priority order: {@link ConvertedDocument.title}, the body's first `#`/`##`
 * heading, then the filename stem. A body that already carries valid OKF
 * front-matter (a non-empty `title`) is returned unchanged — never
 * double-wrapped.
 */
export function ensureOkfFrontMatter(
  filename: string,
  converted: ConvertedDocument,
): string {
  const existingTitle = parseFrontMatter(converted.body)?.['title'];
  if (typeof existingTitle === 'string' && existingTitle.trim()) {
    return converted.body;
  }

  const bodyWithoutFrontMatter = converted.body
    .replace(FRONT_MATTER, '')
    .trimStart();
  const title =
    converted.title ??
    HEADING.exec(bodyWithoutFrontMatter)?.[1]?.trim() ??
    path.basename(filename, path.extname(filename));

  return `---\n${dumpYaml({ title })}---\n\n${bodyWithoutFrontMatter}`;
}
