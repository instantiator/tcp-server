import { describe, expect, it } from 'vitest';
import type { RoleDTO } from '../../api/dtos';
import { rolesForMenu } from './rolesForMenu';

const COMPANY_ID = 'company-1';

const roleFixture = (id: string, name: string): RoleDTO => ({
  id,
  companyId: COMPANY_ID,
  slug: id,
  name,
  description: 'd',
  knowledgeDomains: [],
  mcpServerList: [],
  queryIndex: 0,
});

describe('rolesForMenu', () => {
  it('sorts roles by name', () => {
    const roles = [
      roleFixture('role-c', 'Legal'),
      roleFixture('role-a', 'Accounts'),
      roleFixture('role-b', 'Delivery'),
    ];

    expect(rolesForMenu(roles).map((role) => role.name)).toEqual([
      'Accounts',
      'Delivery',
      'Legal',
    ]);
  });

  it('does not mutate the input array', () => {
    const roles = [
      roleFixture('role-b', 'Legal'),
      roleFixture('role-a', 'Accounts'),
    ];
    const original = [...roles];

    rolesForMenu(roles);

    expect(roles).toEqual(original);
  });
});
