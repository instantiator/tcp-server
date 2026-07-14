import { ApiOptions } from './api';
import * as apiModule from './api';
import { resolveKnowledgeScopePath } from './resolve-knowledge-scope';

const api: ApiOptions = { baseUrl: 'http://localhost:3000' };

describe('resolveKnowledgeScopePath', () => {
  it('returns the role path segment as-is when --role is a UUID, without a network call', async () => {
    const spy = jest.spyOn(apiModule, 'apiRequest');
    const uuid = '11111111-2222-3333-4444-555555555555';
    const result = await resolveKnowledgeScopePath(api, { role: uuid });
    expect(result).toBe(`role/${uuid}`);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('resolves a role slug scoped to --company via the by-slug endpoint', async () => {
    const spy = jest
      .spyOn(apiModule, 'apiRequest')
      .mockResolvedValue({ id: 'role-id' });
    const result = await resolveKnowledgeScopePath(api, {
      role: 'analyst',
      company: 'acme',
    });
    expect(result).toBe('role/role-id');
    expect(spy).toHaveBeenCalledWith(
      api,
      'GET',
      '/api/company/acme/roles/by-slug/analyst',
    );
    spy.mockRestore();
  });

  it('throws when --role is a slug without --company', async () => {
    await expect(
      resolveKnowledgeScopePath(api, { role: 'analyst' }),
    ).rejects.toThrow('--role <slug> requires --company');
  });

  it('returns the company path segment as-is (slug or UUID), without a network call', async () => {
    const spy = jest.spyOn(apiModule, 'apiRequest');
    const result = await resolveKnowledgeScopePath(api, { company: 'acme' });
    expect(result).toBe('company/acme');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('throws when neither --role nor --company is given', async () => {
    await expect(resolveKnowledgeScopePath(api, {})).rejects.toThrow(
      'Provide either --role <slug-or-id> or --company <slug-or-id>',
    );
  });
});
