import * as fs from 'fs';
import * as path from 'path';
import { BadRequestException } from '@nestjs/common';

// pdf-parse (pdfjs-dist) sets up its text-extraction worker via a dynamic
// `import()`, which Jest's default (non-ESM) test environment rejects with
// "A dynamic import callback was invoked without --experimental-vm-modules"
// — a Jest sandboxing limitation, not a real runtime issue (confirmed
// working under plain Node). Mocked here so this suite exercises our own
// convertPdf wiring; real end-to-end PDF extraction is covered by the
// running server in test/api/api.spec.ts.
const getText = jest.fn().mockResolvedValue({ text: 'Sample PDF content' });
const destroy = jest.fn().mockResolvedValue(undefined);
jest.mock('pdf-parse', () => ({
  PDFParse: jest.fn().mockImplementation(() => ({ getText, destroy })),
}));

import {
  convertToMarkdown,
  ensureOkfFrontMatter,
} from './knowledge-conversion';

const fixture = (name: string) =>
  fs.readFileSync(path.join(__dirname, 'fixtures', name));

describe('convertToMarkdown', () => {
  describe('.md', () => {
    it('passes content through unchanged and reads the front-matter title', async () => {
      const content = '---\ntitle: Report\n---\n\nBody text.';
      const result = await convertToMarkdown(
        'doc.md',
        Buffer.from(content, 'utf-8'),
      );
      expect(result).toEqual({ title: 'Report', body: content });
    });

    it('returns a null title when front-matter is absent', async () => {
      const content = '# Heading\n\nBody text.';
      const result = await convertToMarkdown(
        'doc.md',
        Buffer.from(content, 'utf-8'),
      );
      expect(result).toEqual({ title: null, body: content });
    });
  });

  describe('.txt', () => {
    it('returns the raw text with a null title', async () => {
      const result = await convertToMarkdown(
        'notes.txt',
        Buffer.from('Just some notes.', 'utf-8'),
      );
      expect(result).toEqual({ title: null, body: 'Just some notes.' });
    });
  });

  describe('.html', () => {
    it('extracts the <title> and converts the body via turndown+gfm', async () => {
      const html = `<html><head><title>Page Title</title></head>
        <body><h1>Heading</h1><table><tr><th>A</th></tr><tr><td>1</td></tr></table></body></html>`;
      const result = await convertToMarkdown(
        'page.html',
        Buffer.from(html, 'utf-8'),
      );
      expect(result.title).toBe('Page Title');
      expect(result.body).toContain('# Heading');
      // gfm plugin support for tables:
      expect(result.body).toContain('| A |');
    });

    it('returns a null title when there is no <title> tag', async () => {
      const html = '<html><body><p>No title here.</p></body></html>';
      const result = await convertToMarkdown(
        'page.html',
        Buffer.from(html, 'utf-8'),
      );
      expect(result.title).toBeNull();
    });
  });

  describe('.pdf', () => {
    it('extracts plain text with a null title, and releases the parser', async () => {
      const result = await convertToMarkdown(
        'report.pdf',
        fixture('sample.pdf'),
      );
      expect(result).toEqual({ title: null, body: 'Sample PDF content' });
      expect(destroy).toHaveBeenCalled();
    });
  });

  describe('.docx', () => {
    it('converts to Markdown and takes the title from the first heading', async () => {
      const result = await convertToMarkdown(
        'report.docx',
        fixture('sample.docx'),
      );
      expect(result.title).toBe('Sample Heading');
      expect(result.body).toContain('Sample docx content.');
    });
  });

  describe('.csv', () => {
    it('wraps well-formed CSV in a fenced code block', async () => {
      const result = await convertToMarkdown(
        'data.csv',
        Buffer.from('a,b\n1,2\n', 'utf-8'),
      );
      expect(result).toEqual({
        title: null,
        body: '```csv\na,b\n1,2\n\n```\n',
      });
    });

    it('rejects malformed CSV', async () => {
      const malformed = 'a,b\n"unterminated';
      await expect(
        convertToMarkdown('data.csv', Buffer.from(malformed, 'utf-8')),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('.json', () => {
    it('wraps well-formed JSON in a fenced code block', async () => {
      const result = await convertToMarkdown(
        'data.json',
        Buffer.from('{"a":1}', 'utf-8'),
      );
      expect(result).toEqual({ title: null, body: '```json\n{"a":1}\n```\n' });
    });

    it('rejects malformed JSON', async () => {
      await expect(
        convertToMarkdown('data.json', Buffer.from('{not json', 'utf-8')),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('.yaml', () => {
    it('wraps well-formed YAML in a fenced code block', async () => {
      const result = await convertToMarkdown(
        'data.yaml',
        Buffer.from('a: 1\n', 'utf-8'),
      );
      expect(result).toEqual({ title: null, body: '```yaml\na: 1\n\n```\n' });
    });

    it('rejects malformed YAML', async () => {
      const malformed = 'a: [1, 2\n';
      await expect(
        convertToMarkdown('data.yaml', Buffer.from(malformed, 'utf-8')),
      ).rejects.toThrow(BadRequestException);
    });
  });

  it('rejects an unsupported extension', async () => {
    await expect(
      convertToMarkdown('archive.zip', Buffer.from('', 'utf-8')),
    ).rejects.toThrow(BadRequestException);
  });
});

describe('ensureOkfFrontMatter', () => {
  it('uses converted.title when present', () => {
    const result = ensureOkfFrontMatter('page.html', {
      title: 'HTML Title',
      body: 'Some body text.',
    });
    expect(result).toBe('---\ntitle: HTML Title\n---\n\nSome body text.');
  });

  it('falls back to the first heading when no title is set', () => {
    const result = ensureOkfFrontMatter('notes.txt', {
      title: null,
      body: '# Body Heading\n\nText.',
    });
    expect(result).toBe(
      '---\ntitle: Body Heading\n---\n\n# Body Heading\n\nText.',
    );
  });

  it('falls back to the filename stem when there is no title or heading', () => {
    const result = ensureOkfFrontMatter('quarterly-notes.txt', {
      title: null,
      body: 'Plain text, no headings.',
    });
    expect(result).toBe(
      '---\ntitle: quarterly-notes\n---\n\nPlain text, no headings.',
    );
  });

  it('returns already-valid OKF content unchanged (no double-wrap)', () => {
    const body = '---\ntitle: Existing\n---\n\nContent.';
    expect(ensureOkfFrontMatter('doc.md', { title: 'Existing', body })).toBe(
      body,
    );
  });

  it('strips an existing front-matter block that is missing a title, then regenerates one', () => {
    const body = '---\nauthor: Bob\n---\n\n# Real Heading\n\nContent.';
    const result = ensureOkfFrontMatter('doc.md', { title: null, body });
    expect(result).toBe(
      '---\ntitle: Real Heading\n---\n\n# Real Heading\n\nContent.',
    );
  });
});
