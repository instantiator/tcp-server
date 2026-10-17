import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { zipSync } from 'fflate';
import { apiDownload } from '../core/api';
import { resolveToken } from '../auth/token';
import { newTemplateAction } from './new-template.action';

jest.mock('../core/api');
jest.mock('../auth/token');

const mockedDownload = jest.mocked(apiDownload);
const opts = { tcpServer: 'http://localhost:3000' };

/** Makes the download return a zip of the given entries. */
function serve(files: Record<string, string>): void {
  const entries = Object.fromEntries(
    Object.entries(files).map(([name, text]) => [
      name,
      new TextEncoder().encode(text),
    ]),
  );
  mockedDownload.mockResolvedValue({
    data: Buffer.from(zipSync(entries)),
    contentType: 'application/zip',
    filename: 'blank.zip',
  });
}

describe('newTemplateAction', () => {
  let tmp: string;
  let exitSpy: jest.SpyInstance;
  const spies: jest.SpyInstance[] = [];

  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(resolveToken).mockResolvedValue('token');
    spies.push(
      jest.spyOn(process.stdout, 'write').mockImplementation(() => true),
      jest.spyOn(process.stderr, 'write').mockImplementation(() => true),
    );
    exitSpy = jest
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);
    spies.push(exitSpy);
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'new-template-'));
  });

  afterEach(() => {
    spies.splice(0).forEach((spy) => spy.mockRestore());
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('unpacks the blank template into a new directory', async () => {
    serve({ 'company.yaml': 'a', 'roles/r.md': 'b' });
    const dir = path.join(tmp, 'mine');

    await newTemplateAction(opts, dir);

    expect(mockedDownload).toHaveBeenCalledWith(
      expect.anything(),
      '/api/template/builtin/blank',
    );
    expect(fs.readFileSync(path.join(dir, 'roles', 'r.md'), 'utf8')).toBe('b');
  });

  it('refuses a non-empty directory without downloading', async () => {
    fs.writeFileSync(path.join(tmp, 'file'), 'x');

    await newTemplateAction(opts, tmp);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mockedDownload).not.toHaveBeenCalled();
  });

  it('refuses a .. entry and writes nothing', async () => {
    serve({ 'ok.md': 'a', '../evil.md': 'b' });
    const dir = path.join(tmp, 'mine');

    await newTemplateAction(opts, dir);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(fs.existsSync(dir)).toBe(false);
    expect(fs.existsSync(path.join(tmp, 'evil.md'))).toBe(false);
  });
});
