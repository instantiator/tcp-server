import { apiRequest } from '../core/api';
import { confirmAction } from '../core/confirm';
import { resolveToken } from '../auth/token';
import { deleteCompanyAction, listCompaniesAction } from './company.action';

jest.mock('../core/api');
jest.mock('../core/confirm');
jest.mock('../auth/token');

const mockedApiRequest = apiRequest as jest.Mock;
const mockedConfirm = confirmAction as jest.Mock;
const mockedResolveToken = resolveToken as jest.Mock;

const opts = { tcpServer: 'http://localhost:3000' };
const company = { id: 'company-id', slug: 'acme', name: 'Acme Corp' };

describe('listCompaniesAction', () => {
  let stdoutSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockedResolveToken.mockResolvedValue('token');
    stdoutSpy = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => stdoutSpy.mockRestore());

  it('requests the unscoped list — the CLI administers the system', async () => {
    mockedApiRequest.mockResolvedValue([]);

    await listCompaniesAction(opts);

    expect(mockedApiRequest).toHaveBeenCalledWith(
      expect.anything(),
      'GET',
      '/api/company?all=true',
    );
  });

  it('renders the same four columns as before the stats were added', async () => {
    mockedApiRequest.mockResolvedValue([
      {
        ...company,
        description: 'Makes everything',
        stats: { activeAgents: 2 },
      },
    ]);

    await listCompaniesAction(opts);

    const written = (stdoutSpy.mock.calls[0] as [string])[0];
    expect(JSON.parse(written)).toEqual([
      {
        id: 'company-id',
        slug: 'acme',
        name: 'Acme Corp',
        description: 'Makes everything',
      },
    ]);
  });
});

describe('deleteCompanyAction', () => {
  let exitSpy: jest.SpyInstance;
  let stderrSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockedResolveToken.mockResolvedValue('token');
    exitSpy = jest
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);
    stderrSpy = jest
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('errors when neither --company-id nor --company-slug is given', async () => {
    await deleteCompanyAction(opts, {});
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mockedApiRequest).not.toHaveBeenCalled();
  });

  it('errors when the company does not resolve', async () => {
    mockedApiRequest.mockResolvedValueOnce({});
    await deleteCompanyAction(opts, { companyId: 'no-such-co' });
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('not found'),
    );
  });

  it('resolves via a combined --company value', async () => {
    mockedApiRequest.mockResolvedValueOnce(company); // GET
    mockedApiRequest.mockResolvedValueOnce(undefined); // DELETE

    await deleteCompanyAction(opts, { company: 'acme', force: true });

    expect(mockedApiRequest).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      'GET',
      '/api/company/acme',
    );
  });

  it('deletes without prompting when --force is given', async () => {
    mockedApiRequest.mockResolvedValueOnce(company); // GET
    mockedApiRequest.mockResolvedValueOnce(undefined); // DELETE

    await deleteCompanyAction(opts, { companyId: 'acme', force: true });

    expect(mockedConfirm).not.toHaveBeenCalled();
    expect(mockedApiRequest).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      'DELETE',
      `/api/company/${company.id}`,
    );
  });

  it('prompts for confirmation and deletes when confirmed', async () => {
    mockedApiRequest.mockResolvedValueOnce(company);
    mockedApiRequest.mockResolvedValueOnce(undefined);
    mockedConfirm.mockResolvedValue(true);

    await deleteCompanyAction(opts, { companyId: 'acme' });

    expect(mockedConfirm).toHaveBeenCalledTimes(1);
    expect(mockedApiRequest).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      'DELETE',
      `/api/company/${company.id}`,
    );
  });

  it('aborts without deleting when the user declines', async () => {
    mockedApiRequest.mockResolvedValueOnce(company);
    mockedConfirm.mockResolvedValue(false);

    await deleteCompanyAction(opts, { companyId: 'acme' });

    expect(mockedApiRequest).toHaveBeenCalledTimes(1); // GET only, no DELETE
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Aborted'));
  });
});
