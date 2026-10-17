import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { unzipSync } from 'fflate';
import { apiUpload } from '../core/api';
import { resolveToken } from '../auth/token';
import { importCompanyAction } from './import-company.action';

jest.mock('../core/api');
jest.mock('../auth/token');

const mockedUpload = jest.mocked(apiUpload);
const opts = { tcpServer: 'http://localhost:3000' };

/** The `options` form field of the nth upload call, parsed. */
function sentOptions(call: number): Record<string, unknown> {
  const fields = mockedUpload.mock.calls[call][5] ?? {};
  return JSON.parse(fields['options']) as Record<string, unknown>;
}

describe('importCompanyAction', () => {
  let dir: string;
  let stdoutSpy: jest.SpyInstance;
  let stderrSpy: jest.SpyInstance;
  let exitSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(resolveToken).mockResolvedValue('token');
    mockedUpload.mockResolvedValue({ roles: [{ slug: 'a' }, { slug: 'b' }] });
    stdoutSpy = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    stderrSpy = jest
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    exitSpy = jest
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'import-company-'));
    fs.mkdirSync(path.join(dir, 'roles'));
    fs.writeFileSync(path.join(dir, 'company.yaml'), 'slug: x\n');
    fs.writeFileSync(path.join(dir, 'roles', 'a.md'), 'role');
    fs.writeFileSync(path.join(dir, '.DS_Store'), 'junk');
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('zips a directory with relative paths and skips .DS_Store', async () => {
    await importCompanyAction(opts, dir, {});

    const data = mockedUpload.mock.calls[0][3];
    expect(
      Object.keys(unzipSync(new Uint8Array(data as Buffer))).sort(),
    ).toEqual(['company.yaml', 'roles/a.md']);
  });

  it('sends no replace unless --replace is given', async () => {
    await importCompanyAction(opts, dir, {});
    await importCompanyAction(opts, dir, { replace: true });

    expect(sentOptions(0)).not.toHaveProperty('replace');
    expect(sentOptions(1)).toEqual({ replace: true });
  });

  it('maps every previewed role to false for --no-role-models', async () => {
    await importCompanyAction(opts, dir, { roleModels: false });

    expect(mockedUpload.mock.calls[0][1]).toBe('/api/company/import/preview');
    expect(sentOptions(1)).toEqual({ roleModels: { a: false, b: false } });
  });

  it('parses --llm-config, including null', async () => {
    await importCompanyAction(opts, dir, { llmConfig: 'null' });

    expect(sentOptions(0)).toEqual({ llmConfig: null });
  });

  it('sends --template as a field with no file', async () => {
    await importCompanyAction(opts, undefined, { template: 'builtin/basic' });

    expect(mockedUpload.mock.calls[0][3]).toBeNull();
    expect(mockedUpload.mock.calls[0][5]).toEqual({
      template: 'builtin/basic',
      options: '{}',
    });
  });

  it('rejects a path together with --template', async () => {
    await importCompanyAction(opts, dir, { template: 'builtin/basic' });

    expect(mockedUpload).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('rejects neither a path nor --template', async () => {
    await importCompanyAction(opts, undefined, {});

    expect(mockedUpload).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('calls only the preview route for --preview', async () => {
    await importCompanyAction(opts, dir, { preview: true });

    expect(mockedUpload).toHaveBeenCalledTimes(1);
    expect(mockedUpload.mock.calls[0][1]).toBe('/api/company/import/preview');
  });
});
