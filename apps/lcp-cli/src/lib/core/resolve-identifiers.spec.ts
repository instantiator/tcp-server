import { ApiOptions } from './api';
import * as apiModule from './api';
import { resolveCompanyId, resolveRoleId } from './resolve-identifiers';

const api: ApiOptions = { baseUrl: 'http://localhost:3000' };

describe('resolveCompanyId', () => {
  it('returns --company-id as-is without a network call', async () => {
    const spy = jest.spyOn(apiModule, 'apiRequest');
    const result = await resolveCompanyId(api, { companyId: 'abc-123' });
    expect(result).toBe('abc-123');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('resolves --company-slug via GET /api/company/:slug', async () => {
    const spy = jest
      .spyOn(apiModule, 'apiRequest')
      .mockResolvedValue({ id: 'resolved-id' });
    const result = await resolveCompanyId(api, { companySlug: 'acme' });
    expect(result).toBe('resolved-id');
    expect(spy).toHaveBeenCalledWith(api, 'GET', '/api/company/acme');
    spy.mockRestore();
  });

  it('throws when neither option is given', async () => {
    await expect(resolveCompanyId(api, {})).rejects.toThrow(
      'Provide either --company-id or --company-slug',
    );
  });
});

describe('resolveRoleId', () => {
  it('returns --role-id as-is without a network call', async () => {
    const spy = jest.spyOn(apiModule, 'apiRequest');
    const result = await resolveRoleId(api, { roleId: 'role-123' });
    expect(result).toBe('role-123');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('resolves --role-slug scoped to a resolved company', async () => {
    const spy = jest
      .spyOn(apiModule, 'apiRequest')
      .mockResolvedValueOnce({ id: 'company-id' })
      .mockResolvedValueOnce({ id: 'role-id' });

    const result = await resolveRoleId(api, {
      roleSlug: 'analyst',
      companySlug: 'acme',
    });

    expect(result).toBe('role-id');
    expect(spy).toHaveBeenNthCalledWith(1, api, 'GET', '/api/company/acme');
    expect(spy).toHaveBeenNthCalledWith(
      2,
      api,
      'GET',
      '/api/company/company-id/roles/by-slug/analyst',
    );
    spy.mockRestore();
  });

  it('throws when --role-slug is given without a company identifier', async () => {
    await expect(resolveRoleId(api, { roleSlug: 'analyst' })).rejects.toThrow(
      '--role-slug requires --company-id or --company-slug',
    );
  });

  it('throws when neither role option is given', async () => {
    await expect(resolveRoleId(api, {})).rejects.toThrow(
      'Provide either --role-id or --role-slug',
    );
  });
});
