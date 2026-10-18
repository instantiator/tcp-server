import { describe, expect, it } from 'vitest';
import {
  MEDIA_PREVIEW_MAX_BYTES,
  TEXT_PREVIEW_MAX_BYTES,
  mimeFor,
  previewKind,
} from './previewKind';

describe('previewKind', () => {
  it.each([
    ['a.md', 'markdown'],
    ['a.markdown', 'markdown'],
    ['a.csv', 'csv'],
    ['a.txt', 'text'],
    ['a.json', 'text'],
    ['a.jsonl', 'text'],
    ['a.yaml', 'text'],
    ['a.yml', 'text'],
    ['a.xml', 'text'],
    ['a.log', 'text'],
    ['a.html', 'text'],
    ['a.htm', 'text'],
    ['a.ini', 'text'],
    ['a.toml', 'text'],
    ['a.ts', 'text'],
    ['a.js', 'text'],
    ['a.css', 'text'],
    ['a.png', 'image'],
    ['a.jpg', 'image'],
    ['a.jpeg', 'image'],
    ['a.gif', 'image'],
    ['a.webp', 'image'],
    ['a.avif', 'image'],
    ['a.svg', 'image'],
    ['a.pdf', 'pdf'],
    ['a.docx', 'none'],
  ])('%s is %s', (name, kind) => {
    expect(previewKind(name, 10)).toBe(kind);
  });

  it('ignores the case of the extension', () => {
    expect(previewKind('A.PDF', 10)).toBe('pdf');
  });

  it('gives no preview to a name with no extension or a leading dot only', () => {
    expect(previewKind('README', 10)).toBe('none');
    expect(previewKind('.env', 10)).toBe('none');
  });

  it('previews text up to its cap and refuses beyond it', () => {
    expect(previewKind('a.txt', TEXT_PREVIEW_MAX_BYTES)).toBe('text');
    expect(previewKind('a.txt', TEXT_PREVIEW_MAX_BYTES + 1)).toBe('tooLarge');
    expect(previewKind('a.md', TEXT_PREVIEW_MAX_BYTES + 1)).toBe('tooLarge');
    expect(previewKind('a.csv', TEXT_PREVIEW_MAX_BYTES + 1)).toBe('tooLarge');
  });

  it('previews media up to its cap and refuses beyond it', () => {
    expect(previewKind('a.png', MEDIA_PREVIEW_MAX_BYTES)).toBe('image');
    expect(previewKind('a.png', MEDIA_PREVIEW_MAX_BYTES + 1)).toBe('tooLarge');
    expect(previewKind('a.pdf', MEDIA_PREVIEW_MAX_BYTES + 1)).toBe('tooLarge');
  });

  it('leaves an unknown kind as none whatever its size', () => {
    expect(previewKind('a.docx', MEDIA_PREVIEW_MAX_BYTES * 2)).toBe('none');
  });
});

describe('mimeFor', () => {
  it('names the type of images and PDFs, and nothing else', () => {
    expect(mimeFor('a.svg')).toBe('image/svg+xml');
    expect(mimeFor('a.PDF')).toBe('application/pdf');
    expect(mimeFor('a.jpg')).toBe('image/jpeg');
    expect(mimeFor('a.docx')).toBeUndefined();
  });
});
