import { UnprocessableEntityException } from '@nestjs/common';
import * as path from 'path';
import { Worker } from 'worker_threads';

/**
 * Office, OpenDocument and PDF files whose text can be extracted (002.11).
 * Legacy `.doc`, `.xls` and `.ppt` aren't: officeparser doesn't read them.
 */
export const EXTRACTABLE_EXTENSIONS = [
  '.docx',
  '.xlsx',
  '.pptx',
  '.odt',
  '.ods',
  '.odp',
  '.pdf',
] as const;

/** Whether `name`'s text can be extracted, judged by its extension. */
export const isExtractable = (name: string): boolean =>
  (EXTRACTABLE_EXTENSIONS as readonly string[]).includes(
    path.extname(name).toLowerCase(),
  );

/** The bounds on one extraction; these files are untrusted. */
export interface ExtractionLimits {
  /** The biggest file read at all. */
  readonly maxInputBytes: number;
  /** The most a zip-based file may unpack to; past it the parse stops. */
  readonly maxUnpackedBytes: number;
  /** How long a parse may run before its worker is stopped. */
  readonly timeoutMs: number;
  /** The most text returned; the rest is cut. */
  readonly maxOutputChars: number;
  /** The worker's heap, so a hostile file can't exhaust the server's. */
  readonly maxHeapMb: number;
}

export const DEFAULT_LIMITS: ExtractionLimits = {
  maxInputBytes: 25 * 1024 * 1024,
  maxUnpackedBytes: 100 * 1024 * 1024,
  timeoutMs: 20_000,
  maxOutputChars: 1_000_000,
  maxHeapMb: 256,
};

/** A file's text as Markdown, and whether it was cut at the output limit. */
export interface ExtractedText {
  readonly markdown: string;
  readonly truncated: boolean;
}

/**
 * The worker's code. It runs as plain Node, outside webpack and Jest, so it
 * `require`s officeparser from `node_modules` and loads pdf.js natively.
 *
 * Before the library loads, every way out to the network is replaced with a
 * function that throws. officeparser makes no request with
 * `allowRemoteAssets: false`; this makes sure no file can change that. With
 * attachments and OCR off, images, embedded objects and macros are never
 * loaded or run: the library only reads the document's XML.
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const blocked = () => {
  throw new Error('Network access is disabled while reading a document');
};
globalThis.fetch = blocked;
for (const name of ['node:http', 'node:https']) {
  const mod = require(name);
  mod.request = blocked;
  mod.get = blocked;
}
const net = require('node:net');
net.connect = blocked;
net.createConnection = blocked;

const { OfficeParser } = require('officeparser');
(async () => {
  const ast = await OfficeParser.parseOffice(Buffer.from(workerData.bytes), {
    allowRemoteAssets: false,
    extractAttachments: false,
    ocr: false,
    decompressionLimits: { maxUncompressedBytes: workerData.maxUnpackedBytes },
  });
  // The document's own metadata would come out as front matter; the
  // caller adds its own where it needs one.
  ast.metadata = {};
  const { value } = await ast.to('md', {
    generateIds: false,
    includeImages: false,
    mdConfig: { fallbackToHtml: false },
  });
  parentPort.postMessage({ markdown: String(value) });
})().catch((error) => {
  // officeparser names what went wrong in \`officeIssue.code\`.
  const issue = error && error.officeIssue;
  parentPort.postMessage({ error: String((issue && issue.code) || '') });
});
`;

/** `---` breaks (and blank lines) before a document's first content. */
const LEADING_BREAKS = /^(?:\s*---[ \t]*\n)+\s*/;

/** The error a parse stopped at the timeout reports. */
const TIMED_OUT = 'TIMED_OUT';

/** What the worker sends back. */
type WorkerReply = { markdown: string } | { error: string };

/** A refusal in plain words, with the file's name. */
const refuse = (name: string, why: string) =>
  new UnprocessableEntityException(`${path.basename(name)} ${why}`);

/**
 * Extracts a document's text as Markdown, for agents to read and for the
 * storage browser's preview (002.11). The parse runs in a worker thread with
 * a heap cap and a timeout, so a hostile or broken file can't stall or
 * exhaust the server; a file over the input cap is refused unread, and a
 * zip-based one that would unpack past its cap stops mid-parse.
 *
 * The text is untrusted: it reaches a model like any other file (003.04).
 *
 * @throws {@link UnprocessableEntityException} for a file that is too large,
 * too slow, or not readable as its extension says.
 */
export async function extractText(
  name: string,
  bytes: Buffer,
  limits: ExtractionLimits = DEFAULT_LIMITS,
): Promise<ExtractedText> {
  if (bytes.length > limits.maxInputBytes) {
    throw refuse(name, 'is too large to read.');
  }
  const reply = await runWorker(bytes, limits);
  if ('error' in reply) {
    throw refuse(
      name,
      reply.error === TIMED_OUT
        ? 'took too long to read.'
        : /LIMIT/.test(reply.error)
          ? 'is too large to read.'
          : `isn't a readable ${path.extname(name).slice(1)} file.`,
    );
  }
  // Pages, sheets and slides open with a `---` break. Leading, it would read
  // as the start of a front-matter block, so it goes.
  const text = reply.markdown.replace(LEADING_BREAKS, '');
  const truncated = text.length > limits.maxOutputChars;
  return {
    markdown: truncated ? text.slice(0, limits.maxOutputChars) : text,
    truncated,
  };
}

/**
 * Runs one parse in a fresh worker, stopping it at the timeout. A worker
 * that dies (out of heap, say) reads as a limit hit.
 *
 * ponytail: a worker per read, no pool and no cache; pool or cache by ETag
 * if reads of large files get slow.
 */
const runWorker = (
  bytes: Buffer,
  limits: ExtractionLimits,
): Promise<WorkerReply> =>
  new Promise((resolve) => {
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { bytes, maxUnpackedBytes: limits.maxUnpackedBytes },
      resourceLimits: { maxOldGenerationSizeMb: limits.maxHeapMb },
    });
    let settled = false;
    const finish = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      outcome();
    };
    const timer = setTimeout(
      () => finish(() => resolve({ error: TIMED_OUT })),
      limits.timeoutMs,
    );
    worker.once('message', (reply: WorkerReply) =>
      finish(() => resolve(reply)),
    );
    worker.once('error', () =>
      finish(() => resolve({ error: 'RESOURCE_LIMIT' })),
    );
    worker.once('exit', () =>
      finish(() => resolve({ error: 'RESOURCE_LIMIT' })),
    );
  });
