import { describe, expect, it } from 'vitest';
import { t } from '../../../../strings';
import type { CompanySnapshot } from '../rules/companySnapshot';
import { createInitialWorld } from '../world/layout';
import type { Avatar, OfficeWorld } from '../world/types';
import { buildOfficeLabels } from './officeLabels';

const SNAPSHOT: CompanySnapshot = {
  roles: [{ id: 'role-1', name: 'Sales' }],
  tasks: [],
  agents: [
    {
      id: 'agent-1',
      roleId: 'role-1',
      assignmentId: 'assign-1',
      taskId: null,
      status: 'running',
      activity: { kind: 'working' },
    },
  ],
};

function avatar(fields: Partial<Avatar> & Pick<Avatar, 'id' | 'kind'>): Avatar {
  return {
    roleId: 'role-1',
    agentId: null,
    assignmentId: null,
    taskId: null,
    deskId: null,
    location: { x: 2, y: 2 },
    target: { kind: 'exit' },
    placeAtTarget: true,
    hasRole: true,
    carrying: null,
    dissociatedSeq: null,
    ...fields,
  };
}

const WORLD: OfficeWorld = {
  ...createInitialWorld(),
  avatars: [
    avatar({ id: 'role:role-1', kind: 'role' }),
    avatar({ id: 'agent-avatar:1', kind: 'agent', agentId: 'agent-1' }),
    avatar({ id: 'agent-avatar:2', kind: 'agent', agentId: null }),
    avatar({ id: 'agent-avatar:3', kind: 'agent', roleId: 'gone' }),
  ],
};

const textsOf = (labels: ReturnType<typeof buildOfficeLabels>) =>
  labels.map((label) => label.text);

describe('buildOfficeLabels', () => {
  it('returns nothing with every toggle off', () => {
    expect(buildOfficeLabels(WORLD, SNAPSHOT, [])).toEqual([]);
  });

  it('returns nothing before the first snapshot', () => {
    expect(buildOfficeLabels(WORLD, null, ['agents', 'rooms'])).toEqual([]);
  });

  it('labels agents with their role and activity, following the avatar', () => {
    const labels = buildOfficeLabels(WORLD, SNAPSHOT, ['agents']);
    expect(labels[0]).toEqual({
      id: 'avatar:agent-avatar:1',
      text: t('visualisation.label.agent', {
        role: 'Sales',
        status: 'running',
        activity: t('visualisation.activity.working'),
      }),
      anchor: { kind: 'avatar', avatarId: 'agent-avatar:1' },
    });
  });

  it('calls an avatar whose agent has finished waiting, and names an unknown role', () => {
    const texts = textsOf(buildOfficeLabels(WORLD, SNAPSHOT, ['agents']));
    expect(texts).toContain(
      t('visualisation.label.agent', {
        role: 'Sales',
        status: 'idle',
        activity: t('visualisation.activity.waiting'),
      }),
    );
    expect(texts).toContain(
      t('visualisation.label.agent', {
        role: t('activity.role.unknown'),
        status: 'idle',
        activity: t('visualisation.activity.waiting'),
      }),
    );
    expect(texts).toHaveLength(3); // the role avatar is not an agent
  });

  it('labels roles only', () => {
    expect(textsOf(buildOfficeLabels(WORLD, SNAPSHOT, ['roles']))).toEqual([
      t('visualisation.label.role', { role: 'Sales' }),
    ]);
  });

  it('labels every piece of furniture at its tile', () => {
    const labels = buildOfficeLabels(WORLD, SNAPSHOT, ['furniture']);
    expect(labels).toHaveLength(WORLD.furniture.length);
    expect(labels.every((label) => label.anchor.kind === 'tile')).toBe(true);
    expect(textsOf(labels)).toContain(t('visualisation.furniture.pigeonholes'));
  });

  it('labels rooms at their doors, leaving out the corridor', () => {
    const labels = buildOfficeLabels(WORLD, SNAPSHOT, ['rooms']);
    expect(textsOf(labels)).toEqual([
      t('visualisation.room.rec'),
      t('visualisation.room.mail'),
      t('visualisation.room.archive'),
    ]);
    const rec = WORLD.rooms.find((room) => room.id === 'rec');
    expect(labels[0]?.anchor).toEqual({ kind: 'tile', tile: rec?.door });
  });
});
