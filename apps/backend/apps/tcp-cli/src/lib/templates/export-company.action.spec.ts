import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { apiDownload } from '../core/api';
import { resolveToken } from '../auth/token';
import { exportCompanyAction } from './export-company.action';

jest.mock('../core/api');
jest.mock('../auth/token');

const mockedDownload = jest.mocked(apiDownload);
const opts = { tcpServer: 'http://localhost:3000' };

describe('exportCompanyAction', () => {
  let dir: string;
  let stdoutSpy: jest.SpyInstance;
  let stderrSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(resolveToken).mockResolvedValue('token');
    mockedDownload.mockResolvedValue({
      data: Buffer.from('zip'),
      contentType: 'application/zip',
      filename: 'acme.zip',
    });
    stdoutSpy = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    stderrSpy = jest
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-company-'));
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('adds ?models=false for --no-models and writes the file', async () => {
    const output = path.join(dir, 'out.zip');
    await exportCompanyAction(opts, {
      companyId: 'c1',
      models: false,
      output,
    });

    expect(mockedDownload).toHaveBeenCalledWith(
      expect.anything(),
      '/api/company/c1/export?models=false',
    );
    expect(fs.readFileSync(output, 'utf8')).toBe('zip');
  });

  it('keeps models by default', async () => {
    await exportCompanyAction(opts, {
      companyId: 'c1',
      output: path.join(dir, 'x.zip'),
    });

    expect(mockedDownload).toHaveBeenCalledWith(
      expect.anything(),
      '/api/company/c1/export',
    );
  });
});
