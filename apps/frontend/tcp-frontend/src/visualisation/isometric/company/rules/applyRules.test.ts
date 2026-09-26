import { describe, expect, it } from 'vitest';

import { createInitialWorld } from '../world/layout';
import { avatarById } from '../world/worldOps';
import { applyRules } from './applyRules';
import type { CompanySnapshot } from './companySnapshot';

function snapshot(): CompanySnapshot {
  return { roles: [{ id: 'a', name: 'Role A' }], tasks: [], agents: [] };
}

describe('applyRules', () => {
  it('runs roleRules: a role in the snapshot gets a role avatar', () => {
    const world = applyRules(createInitialWorld(), snapshot(), {
      firstSnapshot: true,
    });
    expect(avatarById(world, 'role:a')).toBeDefined();
  });

  it('is reference-stable when the rules make no further change', () => {
    const world = applyRules(createInitialWorld(), snapshot(), {
      firstSnapshot: true,
    });
    const again = applyRules(world, snapshot(), { firstSnapshot: false });
    expect(again).toBe(world);
  });
});
