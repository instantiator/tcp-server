import { apiRequest } from '../core/api';
import { resolveToken } from '../auth/token';
import { dbUrlAction } from './db-url.action';

jest.mock('../core/api');
jest.mock('../auth/token');

const mockedApiRequest = jest.mocked(apiRequest);
const mockedResolveToken = jest.mocked(resolveToken);

const opts = { tcpServer: 'http://localhost:3000' };
const companyId = '11111111-2222-3333-4444-555555555555';

describe('dbUrlAction', () => {
  const savedEnv = { ...process.env };
  let stdoutSpy: jest.SpyInstance;
  let written: string[];
  let stderrSpy: jest.SpyInstance;
  let exitSpy: jest.SpyInstance;

  /** The JSON object last written to stdout. */
  const printed = (): unknown => JSON.parse(written.join(''));

  beforeEach(() => {
    jest.clearAllMocks();
    process.env['TCP_HOST_DATABASE_URL'] = 'postgres://host/tcp';
    delete process.env['RECORDS_DATABASE_URL'];
    written = [];
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation((c) => {
      written.push(String(c));
      return true;
    });
    stderrSpy = jest
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('prints the tcp-server URL without --records', async () => {
    await dbUrlAction(opts, {});

    expect(printed()).toEqual({
      database: 'tcp-server',
      url: 'postgres://host/tcp',
    });
    expect(mockedResolveToken).not.toHaveBeenCalled();
  });

  it('falls back to the host URL for --records when RECORDS_DATABASE_URL is unset', async () => {
    await dbUrlAction(opts, { records: true });

    expect(printed()).toEqual({
      database: 'records',
      url: 'postgres://host/tcp',
    });
  });

  it('treats an empty RECORDS_DATABASE_URL as unset', async () => {
    process.env['RECORDS_DATABASE_URL'] = '';

    await dbUrlAction(opts, { records: true });

    expect(printed()).toEqual({
      database: 'records',
      url: 'postgres://host/tcp',
    });
  });

  it('uses RECORDS_DATABASE_URL as-is when set', async () => {
    process.env['RECORDS_DATABASE_URL'] = 'postgres://host/records';

    await dbUrlAction(opts, { records: true });

    expect(printed()).toEqual({
      database: 'records',
      url: 'postgres://host/records',
    });
    expect(mockedResolveToken).not.toHaveBeenCalled();
  });

  it('adds the company filter for --records with a company', async () => {
    mockedResolveToken.mockResolvedValue('token');

    await dbUrlAction(opts, { records: true, companyId });

    expect(printed()).toEqual({
      database: 'records',
      url: 'postgres://host/tcp',
      companyId,
      tables: ['record_table', 'record', 'record_key'],
      filter: `"companyId" = '${companyId}'`,
    });
    expect(mockedApiRequest).not.toHaveBeenCalled();
  });

  it('fails clearly when TCP_HOST_DATABASE_URL is missing', async () => {
    delete process.env['TCP_HOST_DATABASE_URL'];

    await expect(dbUrlAction(opts, {})).rejects.toThrow('exit');

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('./tcp-cli.sh'),
    );
    expect(stdoutSpy).not.toHaveBeenCalled();
  });
});
