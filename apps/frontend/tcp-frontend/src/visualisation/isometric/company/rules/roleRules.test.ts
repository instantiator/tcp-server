import { describe, expect, it } from 'vitest';

import { createInitialWorld } from '../world/layout';
import { avatarById } from '../world/worldOps';
import type { CompanySnapshot, SnapshotRole } from './companySnapshot';
import { applyRoleRules } from './roleRules';

function role(id: string): SnapshotRole {
  return { id, name: `Role ${id}` };
}

function snapshotWithRoles(roleIds: string[]): CompanySnapshot {
  return { roles: roleIds.map(role), tasks: [], agents: [] };
}

describe('applyRoleRules', () => {
  it('adds a role avatar per role, each at its own rec-room spot', () => {
    const world = applyRoleRules(
      createInitialWorld(),
      snapshotWithRoles(['a', 'b']),
    );
    const a = avatarById(world, 'role:a');
    const b = avatarById(world, 'role:b');

    expect(a).toMatchObject({ kind: 'role', roleId: 'a', placeAtTarget: true });
    expect(b).toMatchObject({ kind: 'role', roleId: 'b', placeAtTarget: true });
    expect(a?.target).toEqual({ kind: 'tile', tile: a?.location });
    expect(a?.location).not.toEqual(b?.location);
  });

  it('removes the avatar for a role no longer in the snapshot', () => {
    let world = applyRoleRules(
      createInitialWorld(),
      snapshotWithRoles(['a', 'b']),
    );
    world = applyRoleRules(world, snapshotWithRoles(['a']));

    expect(avatarById(world, 'role:a')).toBeDefined();
    expect(avatarById(world, 'role:b')).toBeUndefined();
  });

  it('is reference-stable when nothing changed', () => {
    const world = applyRoleRules(
      createInitialWorld(),
      snapshotWithRoles(['a']),
    );
    const again = applyRoleRules(world, snapshotWithRoles(['a']));
    expect(again).toBe(world);
  });

  it("skips a role past the rec room's spot ceiling", () => {
    const roleIds = Array.from(
      { length: 29 },
      (_, index) => `r${String(index)}`,
    );
    const world = applyRoleRules(
      createInitialWorld(),
      snapshotWithRoles(roleIds),
    );
    const placed = roleIds.filter(
      (id) => avatarById(world, `role:${id}`) !== undefined,
    );

    expect(placed).toHaveLength(28);
    expect(avatarById(world, 'role:r28')).toBeUndefined();
  });
});
