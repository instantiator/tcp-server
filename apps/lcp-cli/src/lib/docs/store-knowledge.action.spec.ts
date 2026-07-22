import { validateSupportedFileType } from './store-knowledge.action';

describe('validateSupportedFileType', () => {
  it.each([
    'report.md',
    'notes.txt',
    'page.html',
    'sheet.pdf',
    'doc.docx',
    'data.csv',
    'data.json',
    'data.yaml',
  ])('accepts %s', (filename) => {
    expect(validateSupportedFileType(filename)).toBeNull();
  });

  it('is case-insensitive for the extension', () => {
    expect(validateSupportedFileType('report.MD')).toBeNull();
  });

  it('rejects unsupported extensions', () => {
    expect(validateSupportedFileType('archive.zip')).toMatch(
      /unsupported file type/,
    );
  });

  it('rejects files with no extension', () => {
    expect(validateSupportedFileType('README')).toMatch(
      /unsupported file type/,
    );
  });
});
