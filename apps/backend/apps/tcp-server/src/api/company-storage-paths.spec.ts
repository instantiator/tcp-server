import { BadRequestException } from '@nestjs/common';
import { isWritable, purposeOf, toCompanyKey } from './company-storage-paths';

describe('toCompanyKey', () => {
  it.each([
    ['', 'folder', 'acme/'],
    ['resources/', 'folder', 'acme/resources/'],
    ['resources/a b/', 'folder', 'acme/resources/a b/'],
    ['resources/a b/ü.md', 'file', 'acme/resources/a b/ü.md'],
    ['notes..md', 'file', 'acme/notes..md'],
  ] as const)('puts %j (%s) inside the company folder', (path, kind, key) => {
    expect(toCompanyKey('acme', path, kind)).toBe(key);
  });

  it.each([
    ['/x', 'file'],
    ['a\\b', 'file'],
    ['../x', 'file'],
    ['../other/', 'folder'],
    ['a/../b', 'file'],
    ['./a', 'file'],
    ['a//b', 'file'],
    ['a/./', 'folder'],
    ['a\u0000b', 'file'],
    ['a\nb', 'file'],
    ['x'.repeat(1025), 'file'],
    ['resources', 'folder'],
    ['resources/', 'file'],
    ['', 'file'],
  ] as const)('refuses %j as a %s', (path, kind) => {
    expect(() => toCompanyKey('acme', path, kind)).toThrow(BadRequestException);
  });

  it('accepts a path of exactly 1,024 characters', () => {
    expect(() => toCompanyKey('acme', 'x'.repeat(1024), 'file')).not.toThrow();
  });
});

describe('isWritable', () => {
  it.each(['resources/x.md', 'resources/a/', 'resources/'])(
    'allows %j',
    (path) => expect(isWritable(path)).toBe(true),
  );

  it.each([
    '',
    'resources',
    'knowledge/x.md',
    'tasks/t1/completed/',
    'xresources/',
  ])('refuses %j', (path) => expect(isWritable(path)).toBe(false));
});

describe('purposeOf', () => {
  it('takes the first non-empty line, without heading marks', () => {
    expect(purposeOf('\n# Price lists\nmore')).toBe('Price lists');
  });

  it('is empty for an empty README', () => {
    expect(purposeOf('')).toBe('');
    expect(purposeOf('\n  \n')).toBe('');
  });
});
