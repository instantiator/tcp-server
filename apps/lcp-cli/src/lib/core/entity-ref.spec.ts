import { Command } from 'commander';
import { ApiOptions } from './api';
import * as apiModule from './api';
import {
  addCompanyOptions,
  addEntityIdOptions,
  addRoleOptions,
  resolveCompanyId,
  resolveKnowledgeScopePath,
  resolveRoleId,
  resolveRoleIdFrom,
  UUID_RE,
} from './entity-ref';

const api: ApiOptions = { baseUrl: 'http://localhost:3000' };
const UUID = '11111111-2222-3333-4444-555555555555';

afterEach(() => jest.restoreAllMocks());

describe('UUID_RE', () => {
  it('matches a canonical UUID case-insensitively', () => {
    expect(UUID_RE.test(UUID)).toBe(true);
    expect(UUID_RE.test(UUID.toUpperCase())).toBe(true);
  });

  it('rejects a slug', () => {
    expect(UUID_RE.test('acme')).toBe(false);
  });
});

describe('addEntityIdOptions / addCompanyOptions / addRoleOptions', () => {
  it('adds the combined flag plus -id/-slug suffix variants', () => {
    const cmd = addCompanyOptions(new Command('test'));
    const names = cmd.options.map((o) => o.long);
    expect(names).toEqual(['--company', '--company-id', '--company-slug']);
  });

  it('supports a custom flag stem with no short flag (avoids collisions)', () => {
    const cmd = addEntityIdOptions(new Command('test'), {
      flag: 'planner-role',
      label: 'Planner role',
    });
    const names = cmd.options.map((o) => o.long);
    expect(names).toEqual([
      '--planner-role',
      '--planner-role-id',
      '--planner-role-slug',
    ]);
    expect(cmd.options[0].short).toBeUndefined();
  });

  it('marks the combined flag required when asked', () => {
    const cmd = addRoleOptions(new Command('test'), { required: true });
    expect(cmd.options.find((o) => o.long === '--role')?.required).toBe(true);
  });
});

describe('resolveCompanyId', () => {
  it('returns --company-id as-is without a network call', async () => {
    const spy = jest.spyOn(apiModule, 'apiRequest');
    const result = await resolveCompanyId(api, { companyId: 'abc-123' });
    expect(result).toBe('abc-123');
    expect(spy).not.toHaveBeenCalled();
  });

  it('resolves --company-slug via GET /api/company/:slug', async () => {
    const spy = jest
      .spyOn(apiModule, 'apiRequest')
      .mockResolvedValue({ id: 'resolved-id' });
    const result = await resolveCompanyId(api, { companySlug: 'acme' });
    expect(result).toBe('resolved-id');
    expect(spy).toHaveBeenCalledWith(api, 'GET', '/api/company/acme');
  });

  it('treats --company as an id (no call) when it matches UUID_RE', async () => {
    const spy = jest.spyOn(apiModule, 'apiRequest');
    const result = await resolveCompanyId(api, { company: UUID });
    expect(result).toBe(UUID);
    expect(spy).not.toHaveBeenCalled();
  });

  it('treats --company as a slug (resolves via GET) when it does not match UUID_RE', async () => {
    const spy = jest
      .spyOn(apiModule, 'apiRequest')
      .mockResolvedValue({ id: 'resolved-id' });
    const result = await resolveCompanyId(api, { company: 'acme' });
    expect(result).toBe('resolved-id');
    expect(spy).toHaveBeenCalledWith(api, 'GET', '/api/company/acme');
  });

  it('precedence: --company-id wins over --company-slug and --company', async () => {
    const spy = jest.spyOn(apiModule, 'apiRequest');
    const result = await resolveCompanyId(api, {
      companyId: 'id-wins',
      companySlug: 'ignored-slug',
      company: 'ignored-combined',
    });
    expect(result).toBe('id-wins');
    expect(spy).not.toHaveBeenCalled();
  });

  it('precedence: --company-slug wins over --company', async () => {
    const spy = jest
      .spyOn(apiModule, 'apiRequest')
      .mockResolvedValue({ id: 'from-slug' });
    const result = await resolveCompanyId(api, {
      companySlug: 'slug-wins',
      company: 'ignored-combined',
    });
    expect(result).toBe('from-slug');
    expect(spy).toHaveBeenCalledWith(api, 'GET', '/api/company/slug-wins');
  });

  it('throws when nothing is given', async () => {
    await expect(resolveCompanyId(api, {})).rejects.toThrow(
      'Provide a company: --company, --company-id, or --company-slug',
    );
  });
});

describe('resolveRoleId', () => {
  it('returns --role-id as-is without a network call', async () => {
    const spy = jest.spyOn(apiModule, 'apiRequest');
    const result = await resolveRoleId(api, { roleId: 'role-123' });
    expect(result).toBe('role-123');
    expect(spy).not.toHaveBeenCalled();
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
  });

  it('treats --role as an id (no call) when it matches UUID_RE, even without a company', async () => {
    const spy = jest.spyOn(apiModule, 'apiRequest');
    const result = await resolveRoleId(api, { role: UUID });
    expect(result).toBe(UUID);
    expect(spy).not.toHaveBeenCalled();
  });

  it('treats --role as a slug scoped to --company when it does not match UUID_RE', async () => {
    const spy = jest
      .spyOn(apiModule, 'apiRequest')
      .mockResolvedValueOnce({ id: 'company-id' })
      .mockResolvedValueOnce({ id: 'role-id' });

    const result = await resolveRoleId(api, {
      role: 'analyst',
      company: 'acme',
    });

    expect(result).toBe('role-id');
    expect(spy).toHaveBeenNthCalledWith(
      2,
      api,
      'GET',
      '/api/company/company-id/roles/by-slug/analyst',
    );
  });

  it('precedence: --role-id wins over --role-slug and --role', async () => {
    const spy = jest.spyOn(apiModule, 'apiRequest');
    const result = await resolveRoleId(api, {
      roleId: 'id-wins',
      roleSlug: 'ignored',
      role: 'ignored',
    });
    expect(result).toBe('id-wins');
    expect(spy).not.toHaveBeenCalled();
  });

  it('throws when a role slug is given without a resolvable company', async () => {
    await expect(resolveRoleId(api, { roleSlug: 'analyst' })).rejects.toThrow(
      '--role-slug requires a company',
    );
  });

  it('throws when a non-UUID --role is given without a resolvable company', async () => {
    await expect(resolveRoleId(api, { role: 'analyst' })).rejects.toThrow(
      '--role-slug requires a company',
    );
  });

  it('throws when nothing is given', async () => {
    await expect(resolveRoleId(api, {})).rejects.toThrow(
      'Provide a role: --role, --role-id, or --role-slug',
    );
  });
});

describe('resolveRoleIdFrom (custom label, e.g. planner-role)', () => {
  it('uses a custom error label', async () => {
    await expect(
      resolveRoleIdFrom(api, {}, {}, 'planner-role'),
    ).rejects.toThrow('Provide a planner-role');
  });
});

describe('resolveKnowledgeScopePath', () => {
  it('returns the role path segment as-is when --role is a UUID, without a network call', async () => {
    const spy = jest.spyOn(apiModule, 'apiRequest');
    const result = await resolveKnowledgeScopePath(api, { role: UUID });
    expect(result).toBe(`role/${UUID}`);
    expect(spy).not.toHaveBeenCalled();
  });

  it('resolves a role slug scoped to --company via the by-slug endpoint', async () => {
    const spy = jest
      .spyOn(apiModule, 'apiRequest')
      .mockResolvedValueOnce({ id: 'company-id' })
      .mockResolvedValueOnce({ id: 'role-id' });
    const result = await resolveKnowledgeScopePath(api, {
      role: 'analyst',
      company: 'acme',
    });
    expect(result).toBe('role/role-id');
    expect(spy).toHaveBeenNthCalledWith(1, api, 'GET', '/api/company/acme');
    expect(spy).toHaveBeenNthCalledWith(
      2,
      api,
      'GET',
      '/api/company/company-id/roles/by-slug/analyst',
    );
  });

  it('throws when --role is a slug without --company', async () => {
    await expect(
      resolveKnowledgeScopePath(api, { role: 'analyst' }),
    ).rejects.toThrow('--role-slug requires a company');
  });

  it('returns the company path segment as-is (slug or UUID), without a network call', async () => {
    const spy = jest.spyOn(apiModule, 'apiRequest');
    const result = await resolveKnowledgeScopePath(api, { company: 'acme' });
    expect(result).toBe('company/acme');
    expect(spy).not.toHaveBeenCalled();
  });

  it('prefers --role over --company when both are given', async () => {
    const spy = jest
      .spyOn(apiModule, 'apiRequest')
      .mockResolvedValue({ id: 'role-id' });
    const result = await resolveKnowledgeScopePath(api, {
      role: UUID,
      company: 'acme',
    });
    expect(result).toBe(`role/${UUID}`);
    expect(spy).not.toHaveBeenCalled();
  });

  it('throws when neither --role nor --company is given', async () => {
    await expect(resolveKnowledgeScopePath(api, {})).rejects.toThrow(
      'Provide either a role',
    );
  });
});
