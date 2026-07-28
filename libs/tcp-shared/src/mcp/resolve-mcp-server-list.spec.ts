import { resolveMcpServerList } from './resolve-mcp-server-list';

describe('resolveMcpServerList', () => {
  it('includes the system registry servers', () => {
    expect(resolveMcpServerList(['storage', 'memory'], null, null)).toEqual([
      'storage',
      'memory',
    ]);
  });

  it('adds company extras on top of the registry, not in place of it', () => {
    expect(
      resolveMcpServerList(
        ['storage'],
        { mcpServerList: ['custom-company-server'] },
        null,
      ),
    ).toEqual(['storage', 'custom-company-server']);
  });

  it('adds role extras on top of registry and company', () => {
    expect(
      resolveMcpServerList(
        ['storage'],
        { mcpServerList: ['company-extra'] },
        { mcpServerList: ['role-extra'] },
      ),
    ).toEqual(['storage', 'company-extra', 'role-extra']);
  });

  it('dedupes when the same server is listed more than once', () => {
    expect(
      resolveMcpServerList(
        ['storage'],
        { mcpServerList: ['storage'] },
        { mcpServerList: ['storage'] },
      ),
    ).toEqual(['storage']);
  });

  it('treats null/undefined company and role mcpServerList as empty', () => {
    expect(
      resolveMcpServerList(['storage'], { mcpServerList: undefined }, null),
    ).toEqual(['storage']);
  });
});
