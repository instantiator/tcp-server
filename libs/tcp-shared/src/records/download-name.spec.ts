import { recordsDownloadName } from './download-name';

describe('recordsDownloadName', () => {
  it('stamps local time with zero padding and no colons', () => {
    const at = new Date(2026, 0, 2, 3, 4, 5);
    expect(recordsDownloadName('acme', 'orders', 'csv', at)).toBe(
      '2026-01-02 03-04-05 acme orders.csv',
    );
    expect(recordsDownloadName('acme', 'tables', 'zip', at)).toBe(
      '2026-01-02 03-04-05 acme tables.zip',
    );
  });
});
