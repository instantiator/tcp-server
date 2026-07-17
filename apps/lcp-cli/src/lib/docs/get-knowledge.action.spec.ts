import * as fs from 'fs';
import { apiDownload } from '../core/api';
import { resolveToken } from '../auth/token';
import { getKnowledgeAction } from './get-knowledge.action';

jest.mock('../core/api');
jest.mock('../auth/token');
jest.mock('fs');

const mockedApiDownload = apiDownload as jest.Mock;
const mockedResolveToken = resolveToken as jest.Mock;
const mockedWriteFileSync = fs.writeFileSync as jest.Mock;

const opts = { lcpServer: 'http://localhost:3000' };
const roleId = '11111111-2222-3333-4444-555555555555';

describe('getKnowledgeAction', () => {
  let stdoutSpy: jest.SpyInstance;
  let stderrSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockedResolveToken.mockResolvedValue('token');
    stdoutSpy = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    stderrSpy = jest
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('writes the document content to stdout by default', async () => {
    mockedApiDownload.mockResolvedValueOnce({
      data: Buffer.from('# Report'),
      contentType: 'text/markdown',
      filename: 'report.md',
    });

    await getKnowledgeAction(opts, { roleId, file: 'report.md' });

    expect(mockedApiDownload).toHaveBeenCalledWith(
      expect.anything(),
      `/api/role/${roleId}/knowledge/report.md`,
    );
    expect(stdoutSpy).toHaveBeenCalledWith(Buffer.from('# Report'));
    expect(mockedWriteFileSync).not.toHaveBeenCalled();
  });

  it('saves to --out instead of printing, and reports the path on stderr', async () => {
    mockedApiDownload.mockResolvedValueOnce({
      data: Buffer.from('# Report'),
      contentType: 'text/markdown',
      filename: 'report.md',
    });

    await getKnowledgeAction(opts, {
      roleId,
      file: 'report.md',
      out: 'out.md',
    });

    expect(mockedWriteFileSync).toHaveBeenCalledWith(
      expect.stringContaining('out.md'),
      Buffer.from('# Report'),
    );
    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Saved to'));
  });

  it('URL-encodes a filename with special characters', async () => {
    mockedApiDownload.mockResolvedValueOnce({
      data: Buffer.from('x'),
      contentType: 'text/markdown',
      filename: 'a b.md',
    });

    await getKnowledgeAction(opts, { roleId, file: 'a b.md' });

    expect(mockedApiDownload).toHaveBeenCalledWith(
      expect.anything(),
      `/api/role/${roleId}/knowledge/a%20b.md`,
    );
  });
});
