// Remakes the Office and OpenDocument fixtures for document-text.spec.ts
// with officeparser's own generator, so they need no office suite:
//   node apps/backend/apps/tcp-server/src/storage/__fixtures__/make-fixtures.js
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { OfficeParser } = require('officeparser');

const SOURCE = `# Price list

Our prices for 2026.

| Item | Price |
| --- | --- |
| Tea | 3 |
| Coffee | 4 |
`;

(async () => {
  const ast = await OfficeParser.parseOffice(Buffer.from(SOURCE), {
    fileType: 'md',
  });
  for (const format of ['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp']) {
    const { value } = await ast.to(format);
    writeFileSync(join(__dirname, `price-list.${format}`), Buffer.from(value));
  }
})();
