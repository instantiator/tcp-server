import { apiRequest } from '../core/api';
import { resolveSession } from '../auth/token';
import { resolveChatContext } from './context';

jest.mock('../core/api');
jest.mock('../auth/token');

const mockedApiRequest = apiRequest as jest.Mock;
const mockedResolveSession = resolveSession as jest.Mock;

const opts = { lcpServer: 'http://localhost:3000' };
const company = {
  id: 'company-uuid',
  slug: 'acme',
  name: 'Acme',
  llmConfig: null,
};
const role = {
  id: 'role-uuid',
  companyId: 'company-uuid',
  name: 'Analyst',
  llmConfig: null,
};

describe('resolveChatContext', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedResolveSession.mockResolvedValue({ token: 'token' });
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  it('resolves a role by --role-id, deriving the company from it', async () => {
    mockedApiRequest.mockResolvedValueOnce(role); // GET /api/role/:id
    mockedApiRequest.mockResolvedValueOnce(company); // GET /api/company/:id

    const context = await resolveChatContext(opts, { roleId: role.id }, true);

    expect(mockedApiRequest).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      'GET',
      `/api/role/${role.id}`,
    );
    expect(context.roleId).toBe(role.id);
    expect(context.companyId).toBe(company.id);
    expect(context.roleName).toBe(role.name);
  });

  it('resolves a role by --role-slug scoped to --company-slug', async () => {
    mockedApiRequest.mockResolvedValueOnce(role); // GET .../roles/by-slug/:slug
    mockedApiRequest.mockResolvedValueOnce(company); // GET /api/company/:id

    const context = await resolveChatContext(
      opts,
      { roleSlug: 'analyst', companySlug: 'acme' },
      true,
    );

    expect(mockedApiRequest).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      'GET',
      '/api/company/acme/roles/by-slug/analyst',
    );
    expect(context.roleId).toBe(role.id);
    expect(context.companyId).toBe(company.id);
  });

  it('resolves a role by --role-slug scoped to --company-id', async () => {
    mockedApiRequest.mockResolvedValueOnce(role);
    mockedApiRequest.mockResolvedValueOnce(company);

    await resolveChatContext(
      opts,
      { roleSlug: 'analyst', companyId: 'company-uuid' },
      true,
    );

    expect(mockedApiRequest).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      'GET',
      '/api/company/company-uuid/roles/by-slug/analyst',
    );
  });

  it('browses a company by --company-slug with no role', async () => {
    mockedApiRequest.mockResolvedValueOnce(company); // GET /api/company/:slug

    const context = await resolveChatContext(
      opts,
      { companySlug: 'acme' },
      true,
    );

    expect(mockedApiRequest).toHaveBeenCalledWith(
      expect.anything(),
      'GET',
      '/api/company/acme',
    );
    expect(context.roleId).toBeUndefined();
    expect(context.companyId).toBe(company.id);
  });

  it('normalises companyId to the real UUID even when resolved via a company slug', async () => {
    mockedApiRequest.mockResolvedValueOnce(company);

    const context = await resolveChatContext(
      opts,
      { companySlug: 'acme' },
      true,
    );

    expect(context.companyId).toBe('company-uuid');
    expect(context.companyId).not.toBe('acme');
  });
});
