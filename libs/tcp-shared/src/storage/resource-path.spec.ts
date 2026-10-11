import { normaliseResourcePath } from './resource-path';

describe('normaliseResourcePath', () => {
  it.each([
    ['price-list.md', 'price-list.md'],
    ['  invoices/INV-0042.md ', 'invoices/INV-0042.md'],
    ['/price-list.md', 'price-list.md'],
    ['resources/price-list.md', 'price-list.md'],
    ['acme/resources/invoices/a.md', 'invoices/a.md'],
    ['invoices\\a.md', 'invoices/a.md'],
    ['invoices//a.md', 'invoices/a.md'],
  ])('accepts %j as %j', (raw, path) => {
    expect(normaliseResourcePath(raw, 'acme')).toEqual({ path });
  });

  it("keeps another company's prefix as an ordinary folder name", () => {
    expect(normaliseResourcePath('otherco/resources/a.md', 'acme')).toEqual({
      path: 'otherco/resources/a.md',
    });
  });

  it.each([
    ['', 'is required'],
    ['   ', 'is required'],
    ['resources/', 'is required'],
    ['../secrets.md', "can't contain '..'"],
    ['invoices/../../x.md', "can't contain '..'"],
    ['_deleted/a.md', 'Deleted files'],
    ['invoices/', 'is a folder. Use list_resources'],
  ])('refuses %j as a file', (raw, message) => {
    const result = normaliseResourcePath(raw, 'acme');
    expect('error' in result && result.error).toContain(message);
  });

  it.each([
    [undefined, ''],
    ['', ''],
    ['resources', ''],
    ['resources/', ''],
    ['invoices/', 'invoices'],
    ['/acme/resources/invoices/2026', 'invoices/2026'],
  ])('accepts folder %j as %j', (raw, path) => {
    expect(normaliseResourcePath(raw, 'acme', { folder: true })).toEqual({
      path,
    });
  });

  it('still refuses .. in a folder path', () => {
    const result = normaliseResourcePath('../x', 'acme', { folder: true });
    expect('error' in result).toBe(true);
  });
});
