import { mimeFromExt } from './upload-shared-document.action';

describe('upload-shared-document mimeFromExt', () => {
  it('returns text/markdown for .md', () => {
    expect(mimeFromExt('report.md')).toBe('text/markdown');
  });

  it('returns text/plain for .txt', () => {
    expect(mimeFromExt('notes.txt')).toBe('text/plain');
  });

  it('returns application/json for .json', () => {
    expect(mimeFromExt('data.json')).toBe('application/json');
  });

  it('returns application/pdf for .pdf', () => {
    expect(mimeFromExt('doc.pdf')).toBe('application/pdf');
  });

  it('returns image/jpeg for .jpg and .jpeg', () => {
    expect(mimeFromExt('photo.jpg')).toBe('image/jpeg');
    expect(mimeFromExt('photo.jpeg')).toBe('image/jpeg');
  });

  it('returns image/png for .png', () => {
    expect(mimeFromExt('icon.png')).toBe('image/png');
  });

  it('returns application/octet-stream for unknown extensions', () => {
    expect(mimeFromExt('archive.tar.gz')).toBe('application/octet-stream');
    expect(mimeFromExt('noextension')).toBe('application/octet-stream');
  });
});
