import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { apiDownload } from '../core/api';
import { resolveToken } from '../auth/token';
import { exportTableAction } from './export-table.action';

jest.mock('../core/api');
jest.mock('../auth/token');

const mockedApiDownload = jest.mocked(apiDownload);
const mockedResolveToken = jest.mocked(resolveToken);

const opts = { tcpServer: 'http://localhost:3000' };
const csv = Buffer.from('a,b\n1,2\n');

describe('exportTableAction', () => {
  let stdoutSpy: jest.SpyInstance;
  let stderrSpy: jest.SpyInstance;
  let dir: string;

  beforeEach(() => {
    jest.clearAllMocks();
    mockedResolveToken.mockResolvedValue('token');
    mockedApiDownload.mockResolvedValue({
      data: csv,
      contentType: 'text/csv',
      filename: '2026-01-01 00-00-00 acme people.csv',
    });
    stdoutSpy = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    stderrSpy = jest
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-table-'));
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes the raw bytes to stdout, and nothing else, without a target', async () => {
    await exportTableAction(opts, { companyId: 'c1', table: 'people' });

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(stdoutSpy).toHaveBeenCalledWith(csv);
  });

  it('URL-encodes the table name', async () => {
    await exportTableAction(opts, { companyId: 'c1', table: 'my table/x' });

    expect(mockedApiDownload).toHaveBeenCalledWith(
      expect.anything(),
      '/api/company/c1/records/tables/my%20table%2Fx/csv',
    );
  });

  it('uses the server filename when the target is a directory', async () => {
    await exportTableAction(opts, {
      companyId: 'c1',
      table: 'people',
      target: dir,
    });

    const file = path.join(dir, '2026-01-01 00-00-00 acme people.csv');
    expect(fs.readFileSync(file)).toEqual(csv);
    expect(stdoutSpy).toHaveBeenCalledWith(
      expect.stringContaining('"size": 8'),
    );
  });

  it('uses a file target as given', async () => {
    const file = path.join(dir, 'out.csv');

    await exportTableAction(opts, {
      companyId: 'c1',
      table: 'people',
      target: file,
    });

    expect(fs.readFileSync(file)).toEqual(csv);
    expect(stdoutSpy).toHaveBeenCalledWith(
      expect.stringContaining(JSON.stringify(file)),
    );
  });
});
