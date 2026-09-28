import { describe, expect, it } from 'vitest';
import { t } from '../../../../strings';
import type { CompanySnapshot } from '../rules/companySnapshot';
import { createInitialWorld } from '../world/layout';
import type { Avatar, Furniture, OfficeWorld, Room } from '../world/types';
import {
  describeFurniture,
  describeRoom,
  describeTarget,
} from './officeDescriptions';

const SNAPSHOT: CompanySnapshot = {
  roles: [
    { id: 'role-1', name: 'Sales' },
    { id: 'role-2', name: 'Legal' },
  ],
  tasks: [
    {
      id: 'task-1',
      shortcode: 'TASK-1',
      request: 'Reconcile accounts',
      finished: false,
      succeeded: false,
      step: 0,
      steps: 1,
    },
  ],
  agents: [
    {
      id: 'agent-1',
      roleId: 'role-1',
      assignmentId: 'assign-1',
      taskId: 'task-1',
      activity: { kind: 'consulting', oneToOneId: 'consult-1' },
    },
    {
      id: 'agent-2',
      roleId: 'role-2',
      assignmentId: 'consult-1',
      taskId: null,
      activity: { kind: 'consulting', oneToOneId: 'consult-1' },
    },
  ],
};

const BOUNDS = { x: 0, y: 0, width: 9, height: 7 };

function room(id: string, purpose: Room['purpose'], taskId?: string): Room {
  return {
    id,
    purpose,
    slot: 2,
    bounds: BOUNDS,
    door: { x: 4, y: 6 },
    closing: false,
    ...(taskId === undefined ? {} : { taskId }),
  };
}

function furniture(kind: Furniture['kind'], ownerAvatarId?: string): Furniture {
  return {
    id: `x:${kind}`,
    kind,
    roomId: 'x',
    tile: { x: 1, y: 1 },
    ...(ownerAvatarId === undefined ? {} : { ownerAvatarId }),
  };
}

const OWNER: Avatar = {
  id: 'agent-avatar:1',
  kind: 'agent',
  roleId: 'role-1',
  agentId: null,
  assignmentId: null,
  taskId: 'task-1',
  deskId: 'x:desk',
  location: { x: 1, y: 2 },
  target: { kind: 'exit' },
  placeAtTarget: false,
  hasRole: true,
  carrying: null,
  dissociatedSeq: null,
};

const WORLD: OfficeWorld = {
  ...createInitialWorld(),
  avatars: [OWNER],
};

describe('describeFurniture', () => {
  it("names a desk after its owner's role", () => {
    expect(
      describeFurniture(furniture('desk', OWNER.id), WORLD, SNAPSHOT),
    ).toEqual({
      title: t('visualisation.furniture.desk', { role: 'Sales' }),
      description: t('visualisation.furniture.desk.description'),
    });
  });

  it('calls a desk with no owner just a desk', () => {
    expect(describeFurniture(furniture('desk'), WORLD, SNAPSHOT).title).toBe(
      t('visualisation.furniture.deskUnowned'),
    );
  });

  it('gives a whiteboard a title and no description', () => {
    expect(describeFurniture(furniture('whiteboard'), WORLD, SNAPSHOT)).toEqual(
      { title: t('visualisation.furniture.whiteboard') },
    );
  });

  it.each(['sofa', 'pigeonholes', 'table', 'officeDoor', 'bookshelf'] as const)(
    'describes a %s',
    (kind) => {
      expect(describeFurniture(furniture(kind), WORLD, SNAPSHOT)).toEqual({
        title: t(`visualisation.furniture.${kind}`),
        description: t(`visualisation.furniture.${kind}.description`),
      });
    },
  );
});

describe('describeRoom', () => {
  it('names a task room after its task', () => {
    expect(
      describeRoom(room('task:task-1', 'task', 'task-1'), SNAPSHOT),
    ).toEqual({
      title: t('visualisation.room.task', { shortcode: 'TASK-1' }),
      description: t('visualisation.room.task.description', {
        shortcode: 'TASK-1',
      }),
    });
  });

  it('names both roles consulting in a 1:1 room', () => {
    expect(
      describeRoom(room('oneToOne:consult-1', 'oneToOne'), SNAPSHOT)
        ?.description,
    ).toBe(
      t('visualisation.room.oneToOne.description', {
        roleA: 'Sales',
        roleB: 'Legal',
      }),
    );
  });

  it("says 'two agents' once the consultation's agents have gone", () => {
    expect(
      describeRoom(room('oneToOne:consult-1', 'oneToOne'), {
        ...SNAPSHOT,
        agents: [],
      })?.description,
    ).toBe(t('visualisation.room.oneToOne.descriptionUnknown'));
  });

  it.each(['rec', 'mail', 'archive'] as const)(
    'describes the %s room',
    (purpose) => {
      expect(describeRoom(room(purpose, purpose), SNAPSHOT)).toEqual({
        title: t(`visualisation.room.${purpose}`),
        description: t(`visualisation.room.${purpose}.description`),
      });
    },
  );

  it('does not describe the corridor', () => {
    expect(describeRoom(room('corridor', 'corridor'), SNAPSHOT)).toBeNull();
  });
});

describe('describeTarget', () => {
  it('finds a room or furniture in the world by id', () => {
    expect(
      describeTarget({ kind: 'room', id: 'mail' }, WORLD, SNAPSHOT)?.title,
    ).toBe(t('visualisation.room.mail'));
    const door = WORLD.furniture.find((item) => item.kind === 'officeDoor');
    expect(
      describeTarget({ kind: 'furniture', id: door?.id ?? '' }, WORLD, SNAPSHOT)
        ?.title,
    ).toBe(t('visualisation.furniture.officeDoor'));
  });

  it('returns null for an id that has gone', () => {
    expect(
      describeTarget({ kind: 'furniture', id: 'gone' }, WORLD, SNAPSHOT),
    ).toBeNull();
    expect(
      describeTarget({ kind: 'room', id: 'gone' }, WORLD, SNAPSHOT),
    ).toBeNull();
  });
});
