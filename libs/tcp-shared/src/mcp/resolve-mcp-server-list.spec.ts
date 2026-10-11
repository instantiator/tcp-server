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

  describe('toggles', () => {
    const all = ['tasks', 'storage', 'records'];

    it('keeps every server when nothing is toggled', () => {
      expect(resolveMcpServerList(all, { mcpServerToggles: null }, {})).toEqual(
        all,
      );
    });

    it('drops a server the company switches off, for all its roles', () => {
      expect(
        resolveMcpServerList(all, { mcpServerToggles: { records: false } }, {}),
      ).toEqual(['tasks', 'storage']);
    });

    it('lets a role switch back on a server its company switched off', () => {
      expect(
        resolveMcpServerList(
          all,
          { mcpServerToggles: { records: false } },
          { mcpServerToggles: { records: true } },
        ),
      ).toEqual(all);
    });

    it('lets a role switch off a server its company leaves on', () => {
      expect(
        resolveMcpServerList(
          all,
          { mcpServerToggles: { records: true } },
          { mcpServerToggles: { storage: false } },
        ),
      ).toEqual(['tasks', 'records']);
    });

    it('applies to company and role extras too', () => {
      expect(
        resolveMcpServerList(
          ['tasks'],
          { mcpServerList: ['extra'] },
          { mcpServerToggles: { extra: false } },
        ),
      ).toEqual(['tasks']);
    });

    it('ignores a toggle for a server that is not a candidate', () => {
      expect(
        resolveMcpServerList(
          ['tasks'],
          { mcpServerToggles: { records: true } },
          {},
        ),
      ).toEqual(['tasks']);
    });
  });

  it('treats null/undefined company and role mcpServerList as empty', () => {
    expect(
      resolveMcpServerList(['storage'], { mcpServerList: undefined }, null),
    ).toEqual(['storage']);
  });
});
