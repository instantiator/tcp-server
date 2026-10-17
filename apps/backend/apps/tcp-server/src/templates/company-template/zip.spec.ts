import { BadRequestException } from '@nestjs/common';
import { strToU8, zipSync } from 'fflate';
import { readZip, writeZip } from './zip';

const LIMITS = { maxEntries: 10, maxUncompressedBytes: 1_000 };

/** Overwrites every central-directory "uncompressed size" with `size`. */
function lieAboutSizes(zip: Uint8Array, size: number): Uint8Array {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  for (let i = 0; i + 4 <= zip.length; i++) {
    if (view.getUint32(i, true) === 0x02014b50)
      view.setUint32(i + 24, size, true);
  }
  return zip;
}

describe('readZip', () => {
  it('reads what writeZip wrote', () => {
    const files = new Map([
      ['company.json', strToU8('{}')],
      ['roles/a/prompt.md', strToU8('hello')],
    ]);
    expect(readZip(writeZip(files), LIMITS)).toEqual(files);
  });

  it('strips a top-level folder every file shares', () => {
    const zip = zipSync({
      'my-template/company.json': strToU8('{}'),
      'my-template/roles/a/role.json': strToU8('{}'),
    });
    expect([...readZip(zip, LIMITS).keys()].sort()).toEqual([
      'company.json',
      'roles/a/role.json',
    ]);
  });

  it('keeps paths when files sit at the root', () => {
    const zip = zipSync({
      'company.json': strToU8('{}'),
      'knowledge/a.md': strToU8('x'),
    });
    expect([...readZip(zip, LIMITS).keys()].sort()).toEqual([
      'company.json',
      'knowledge/a.md',
    ]);
  });

  it('skips folder entries and macOS litter', () => {
    const zip = zipSync({
      't/': new Uint8Array(),
      't/company.json': strToU8('{}'),
      't/.DS_Store': strToU8('x'),
      '__MACOSX/t/._company.json': strToU8('x'),
    });
    expect([...readZip(zip, LIMITS).keys()]).toEqual(['company.json']);
  });

  it.each([
    ['a parent segment', '../escape.md'],
    ['a nested parent segment', 'roles/../../escape.md'],
    ['an absolute path', '/etc/passwd'],
    ['a drive letter', 'C:/x.md'],
    ['a backslash', 'roles\\a\\role.json'],
  ])('refuses %s', (_label, name) => {
    const zip = zipSync({ [name]: strToU8('x') });
    expect(() => readZip(zip, LIMITS)).toThrow(/Unsafe path/);
  });

  it('refuses too many entries', () => {
    const many = Object.fromEntries(
      Array.from({ length: 11 }, (_, i) => [`f${i}.md`, strToU8('x')]),
    );
    expect(() => readZip(zipSync(many), LIMITS)).toThrow(
      /more than 10 entries/,
    );
  });

  it('refuses an archive whose declared sizes exceed the cap', () => {
    const zip = zipSync({ 'big.md': new Uint8Array(2_000) });
    expect(() => readZip(zip, LIMITS)).toThrow(/more than 1000 bytes/);
  });

  it('never inflates past a declared size that understates the data', () => {
    // A zip bomb declaring 10 bytes gets at most 10 bytes of memory.
    const zip = lieAboutSizes(zipSync({ 'a.md': new Uint8Array(100_000) }), 10);
    expect(readZip(zip, LIMITS).get('a.md')?.length).toBe(10);
  });

  it('refuses a file that is not a zip', () => {
    expect(() => readZip(strToU8('not a zip'), LIMITS)).toThrow(
      BadRequestException,
    );
  });
});
