import { describe, expect, it } from 'vitest';
import { doorFor, hasDoorsUnder, storedName } from './paths';

const ROLES = new Map([['writer', 'role-1']]);
const door = (folder: string) => doorFor(folder, 'company-1', ROLES);

describe('doorFor', () => {
  it('lets resources/ take files straight into storage', () => {
    expect(door('resources/')).toEqual({ kind: 'storage' });
    expect(door('resources/price-lists/')).toEqual({ kind: 'storage' });
  });

  it("sends shared knowledge through the company's knowledge route", () => {
    expect(door('knowledge/shared/')).toEqual({
      kind: 'knowledge',
      scope: { kind: 'company', companyId: 'company-1' },
    });
  });

  it("sends a role's folder through that role's knowledge route, by slug", () => {
    expect(door('knowledge/writer/')).toEqual({
      kind: 'knowledge',
      scope: { kind: 'role', roleId: 'role-1' },
    });
  });

  it.each([
    ['knowledge itself, which is no scope', 'knowledge/'],
    ['a folder with no matching role', 'knowledge/gone/'],
    ['a subfolder, since knowledge is flat', 'knowledge/writer/drafts/'],
    ['a task folder that is not materials', 'tasks/t-1/'],
    ['inside materials, which is flat', 'tasks/t-1/materials/old/'],
    ['the top folder', ''],
    ['anywhere else', 'memories/'],
  ])('takes nothing in %s', (_case, folder) => {
    expect(door(folder)).toBeNull();
  });

  it("sends a task's materials through the materials route", () => {
    expect(door('tasks/t-1/materials/')).toEqual({
      kind: 'materials',
      taskId: 't-1',
    });
  });
});

describe('storedName', () => {
  const knowledge = {
    kind: 'knowledge',
    scope: { kind: 'company', companyId: 'company-1' },
  } as const;

  it.each([
    ['notes.md', 'notes.md'],
    ['README.MD', 'README.MD'],
    ['report.docx', 'report.md'],
    ['data.csv', 'data.md'],
    // As the server does: the extension is stripped only in lower case.
    ['SCAN.PDF', 'SCAN.PDF.md'],
  ])('stores knowledge %s as %s', (name, stored) => {
    expect(storedName(name, knowledge)).toBe(stored);
  });

  it('keeps the name through any other door', () => {
    expect(storedName('report.docx', { kind: 'storage' })).toBe('report.docx');
    expect(storedName('brief.pdf', { kind: 'materials', taskId: 't-1' })).toBe(
      'brief.pdf',
    );
  });
});

describe('hasDoorsUnder', () => {
  it.each([
    '',
    'resources/',
    'resources/a/b/',
    'knowledge/',
    'knowledge/writer/',
    'tasks/',
    'tasks/t-1/',
    'tasks/t-1/materials/',
  ])('shows write controls in a browser rooted at %j', (root) => {
    expect(hasDoorsUnder(root)).toBe(true);
  });

  it.each(['tasks/t-1/completed/', 'knowledge/writer/drafts/', 'memories/'])(
    'shows none in a browser rooted at %j',
    (root) => {
      expect(hasDoorsUnder(root)).toBe(false);
    },
  );
});
