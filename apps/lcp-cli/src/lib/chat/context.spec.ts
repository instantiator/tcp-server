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
  id: '11111111-2222-3333-4444-555555555555',
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

  // The shared resolveRoleId (entity-ref.ts) resolves a role slug to a real
  // UUID (which may itself require resolving a company slug first), and
  // context.ts then fetches the full role/company records — so slug-based
  // resolution here takes more round trips than the old bespoke
  // implementation. Dispatch mocked responses by URL rather than by call
  // position, since the exact count isn't the behaviour under test.
  function mockByUrl(): void {
    mockedApiRequest.mockImplementation(
      (_api: unknown, _method: string, path: string) => {
        if (path === '/api/company/acme') return Promise.resolve(company);
        if (path === `/api/company/${company.id}`)
          return Promise.resolve(company);
        if (
          path === `/api/company/${company.id}/roles/by-slug/analyst` ||
          path === '/api/company/company-uuid/roles/by-slug/analyst'
        )
          return Promise.resolve(role);
        if (path === `/api/role/${role.id}`) return Promise.resolve(role);
        throw new Error(`unexpected path in test: ${path}`);
      },
    );
  }

  it('resolves a role by --role-slug scoped to --company-slug', async () => {
    mockByUrl();

    const context = await resolveChatContext(
      opts,
      { roleSlug: 'analyst', companySlug: 'acme' },
      true,
    );

    expect(context.roleId).toBe(role.id);
    expect(context.companyId).toBe(company.id);
  });

  it('resolves a role by combined --role scoped by --company', async () => {
    mockByUrl();

    const context = await resolveChatContext(
      opts,
      { role: 'analyst', company: 'acme' },
      true,
    );

    expect(context.roleId).toBe(role.id);
    expect(context.companyId).toBe(company.id);
  });

  it('resolves a role by combined --role given as a UUID, without a company', async () => {
    mockByUrl();

    const context = await resolveChatContext(opts, { role: role.id }, true);

    expect(context.roleId).toBe(role.id);
    expect(context.companyId).toBe(company.id);
  });

  it('resolves a role by --role-slug scoped to --company-id', async () => {
    mockByUrl();

    const context = await resolveChatContext(
      opts,
      { roleSlug: 'analyst', companyId: 'company-uuid' },
      true,
    );

    expect(context.roleId).toBe(role.id);
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
