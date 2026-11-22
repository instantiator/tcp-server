import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import * as fs from 'fs';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import * as path from 'path';
import {
  DEFAULT_LIMITS,
  extractText,
  isExtractable,
  type ExtractionLimits,
} from './document-text';

const fixture = (name: string): Buffer =>
  fs.readFileSync(path.join(__dirname, '__fixtures__', name));

const limits = (overrides: Partial<ExtractionLimits>): ExtractionLimits => ({
  ...DEFAULT_LIMITS,
  ...overrides,
});

/** The price-list `.docx` with one of its parts rewritten. */
const docxWith = (
  part: string,
  rewrite: (xml: string) => string,
  extra: Record<string, string> = {},
): Buffer => {
  const files = unzipSync(fixture('price-list.docx'));
  files[part] = strToU8(rewrite(strFromU8(files[part])));
  for (const [name, xml] of Object.entries(extra)) files[name] = strToU8(xml);
  return Buffer.from(zipSync(files, { level: 9 }));
};

// A worker starts per read, so each case takes a moment.
jest.setTimeout(30_000);

describe('isExtractable', () => {
  it.each(['a.docx', 'B.XLSX', 'c.pptx', 'd.odt', 'e.ods', 'f.odp', 'g.pdf'])(
    'reads %s',
    (name) => {
      expect(isExtractable(name)).toBe(true);
    },
  );

  it.each(['a.doc', 'b.xls', 'c.ppt', 'd.md', 'e.png', 'f'])(
    'leaves %s alone',
    (name) => {
      expect(isExtractable(name)).toBe(false);
    },
  );
});

describe('extractText', () => {
  it.each(['docx', 'odt'])(
    'reads a %s as Markdown, keeping its heading and table',
    async (format) => {
      const { markdown, truncated } = await extractText(
        `price-list.${format}`,
        fixture(`price-list.${format}`),
      );
      expect(markdown).toContain('# Price list');
      expect(markdown).toContain('| Tea | 3 |');
      expect(markdown).not.toMatch(/^---\n(created|modified):/);
      expect(truncated).toBe(false);
    },
  );

  it('starts with content, not a page break that would read as front matter', async () => {
    const { markdown } = await extractText(
      'price-list.xlsx',
      fixture('price-list.xlsx'),
    );
    expect(markdown.startsWith('---')).toBe(false);
  });

  it.each(['xlsx', 'ods'])('reads a %s as Markdown tables', async (format) => {
    const { markdown } = await extractText(
      `price-list.${format}`,
      fixture(`price-list.${format}`),
    );
    expect(markdown).toContain('| Tea | 3 |');
    expect(markdown).toContain('| Coffee | 4 |');
  });

  it.each(['pptx', 'odp'])('reads a %s’s slides', async (format) => {
    const { markdown } = await extractText(
      `price-list.${format}`,
      fixture(`price-list.${format}`),
    );
    expect(markdown).toContain('Price list');
    expect(markdown).toContain('Our prices for 2026.');
  });

  it('reads a PDF', async () => {
    const pdf = fs.readFileSync(
      path.join(__dirname, '..', 'api', 'fixtures', 'sample.pdf'),
    );
    const { markdown } = await extractText('report.pdf', pdf);
    expect(markdown).toContain('Sample PDF content');
  });

  it('refuses a file over the input cap without parsing it', async () => {
    await expect(
      extractText(
        'big.docx',
        fixture('price-list.docx'),
        limits({ maxInputBytes: 10 }),
      ),
    ).rejects.toThrow('big.docx is too large to read.');
  });

  it('stops a zip that would unpack past its cap', async () => {
    // 5 MB of padding compresses to a few kilobytes: a small zip bomb.
    const bomb = docxWith('word/document.xml', (xml) =>
      xml.replace('<w:body>', `<w:body><!--${' '.repeat(5 * 1024 * 1024)}-->`),
    );
    expect(bomb.length).toBeLessThan(64 * 1024);
    await expect(
      extractText('bomb.docx', bomb, limits({ maxUnpackedBytes: 1024 * 1024 })),
    ).rejects.toThrow('bomb.docx is too large to read.');
  });

  it('stops a parse that runs past the timeout', async () => {
    await expect(
      extractText(
        'slow.docx',
        fixture('price-list.docx'),
        limits({ timeoutMs: 1 }),
      ),
    ).rejects.toThrow('slow.docx took too long to read.');
  });

  it('cuts text at the output cap and says so', async () => {
    const { markdown, truncated } = await extractText(
      'price-list.docx',
      fixture('price-list.docx'),
      limits({ maxOutputChars: 10 }),
    );
    expect(markdown).toHaveLength(10);
    expect(truncated).toBe(true);
  });

  it('says a broken file is not readable as its type', async () => {
    await expect(
      extractText('broken.docx', Buffer.from('not a zip at all')),
    ).rejects.toThrow("broken.docx isn't a readable docx file.");
  });

  describe('a document that links outside itself', () => {
    let server: Server;
    let hits = 0;
    let base = '';

    beforeAll(async () => {
      server = createServer((_req, res) => {
        hits += 1;
        res.end('x');
      });
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
      base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    });

    afterAll(async () => {
      await new Promise((resolve) => server.close(resolve));
    });

    it('reads its text and fetches neither a linked image nor a hyperlink', async () => {
      const external = (id: string, type: string, target: string) =>
        `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}" TargetMode="External"/>`;
      const linked = docxWith('word/_rels/document.xml.rels', (xml) =>
        xml.replace(
          '</Relationships>',
          external('rIdImg', 'image', `${base}/tracker.png`) +
            external('rIdLink', 'hyperlink', `${base}/page`) +
            '</Relationships>',
        ),
      );
      const withBody = Buffer.from(
        zipSync(
          {
            ...unzipSync(linked),
            'word/document.xml': strToU8(
              strFromU8(unzipSync(linked)['word/document.xml']).replace(
                '<w:body>',
                '<w:body><w:p><w:hyperlink r:id="rIdLink"><w:r><w:t>Our site</w:t></w:r></w:hyperlink></w:p>' +
                  '<w:p><w:r><w:drawing><wp:inline><wp:extent cx="1" cy="1"/><wp:docPr id="9" name="tracker"/>' +
                  '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
                  '<pic:pic><pic:nvPicPr><pic:cNvPr id="9" name="tracker"/><pic:cNvPicPr/></pic:nvPicPr>' +
                  '<pic:blipFill><a:blip r:link="rIdImg"/></pic:blipFill><pic:spPr/></pic:pic>' +
                  '</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>',
              ),
            ),
          },
          { level: 9 },
        ),
      );

      const { markdown } = await extractText('linked.docx', withBody);
      expect(markdown).toContain('Our site');
      expect(markdown).toContain('# Price list');
      expect(hits).toBe(0);
    });
  });
});
