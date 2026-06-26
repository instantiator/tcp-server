import { validateOkfDocument } from './store-role-documents';

describe('validateOkfDocument', () => {
  const validContent = `---
title: Report
author: Alice
---

# Report

Content here.
`;

  it('accepts a valid OKF document', () => {
    expect(validateOkfDocument('report.md', validContent)).toBeNull();
  });

  it('rejects non-Markdown files', () => {
    expect(validateOkfDocument('report.txt', validContent)).toMatch(
      /must be a Markdown/,
    );
  });

  it('rejects files without front-matter', () => {
    expect(validateOkfDocument('report.md', '# No front matter')).toMatch(
      /title/,
    );
  });

  it('rejects files with front-matter missing the title field', () => {
    const noTitle = `---\nauthor: Bob\n---\ncontent`;
    expect(validateOkfDocument('report.md', noTitle)).toMatch(/title/);
  });

  it('rejects files with an empty title', () => {
    const emptyTitle = `---\ntitle: ""\n---\ncontent`;
    expect(validateOkfDocument('report.md', emptyTitle)).toMatch(/title/);
  });

  it('rejects files with whitespace-only title', () => {
    const spaceTitle = `---\ntitle: "   "\n---\ncontent`;
    expect(validateOkfDocument('report.md', spaceTitle)).toMatch(/title/);
  });

  it('is case-insensitive for the .md extension', () => {
    expect(validateOkfDocument('report.MD', validContent)).toBeNull();
  });
});
