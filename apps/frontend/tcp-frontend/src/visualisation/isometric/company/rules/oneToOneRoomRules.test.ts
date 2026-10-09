import { describe, expect, it } from 'vitest';

import { createInitialWorld, oneToOneRoomId } from '../world/layout';
import { roomById } from '../world/worldOps';
import { applyRules } from './applyRules';
import type { CompanySnapshot, SnapshotAgent } from './companySnapshot';
import { closeOneToOneRooms, openOneToOneRooms } from './oneToOneRoomRules';

function consultingAgent(
  id: string,
  oneToOneId: string,
  overrides: Partial<SnapshotAgent> = {},
): SnapshotAgent {
  return {
    id,
    roleId: 'role-1',
    assignmentId: `${id}-assignment`,
    taskId: null,
    status: 'idle',
    activity: { kind: 'consulting', oneToOneId },
    ...overrides,
  };
}

function snapshot(agents: SnapshotAgent[]): CompanySnapshot {
  return { roles: [], tasks: [], agents };
}

describe('openOneToOneRooms', () => {
  it('opens one 1:1 room per consultation, shared by both its sides', () => {
    const agents = [
      consultingAgent('caller', 'consultee-assignment-1'),
      consultingAgent('consultee', 'consultee-assignment-1'),
    ];
    const world = openOneToOneRooms(createInitialWorld(), snapshot(agents));
    const rooms = world.rooms.filter((room) => room.purpose === 'oneToOne');
    expect(rooms).toHaveLength(1);
    expect(rooms[0]?.id).toBe(oneToOneRoomId('consultee-assignment-1'));
  });

  it('is reference-stable once the room already exists', () => {
    const agents = [consultingAgent('caller', 'c1')];
    const world = openOneToOneRooms(createInitialWorld(), snapshot(agents));
    const again = openOneToOneRooms(world, snapshot(agents));
    expect(again).toBe(world);
  });
});

describe('closeOneToOneRooms', () => {
  it('closes a room once its consultation is no longer active', () => {
    const agents = [consultingAgent('caller', 'c1')];
    let world = openOneToOneRooms(createInitialWorld(), snapshot(agents));
    world = closeOneToOneRooms(world, snapshot([]));
    expect(roomById(world, oneToOneRoomId('c1'))?.closing).toBe(true);
  });

  it('is reference-stable while the consultation is still active', () => {
    const agents = [consultingAgent('caller', 'c1')];
    const world = openOneToOneRooms(createInitialWorld(), snapshot(agents));
    const again = closeOneToOneRooms(world, snapshot(agents));
    expect(again).toBe(world);
  });
});

describe('a consultation, end to end', () => {
  it('creates a 1:1 room and sends both sides to its table', () => {
    const oneToOneId = 'consultee-assignment-1';
    const agents = [
      consultingAgent('caller', oneToOneId),
      consultingAgent('consultee', oneToOneId),
    ];

    const world = applyRules(createInitialWorld(), snapshot(agents), {
      firstSnapshot: true,
    });

    const roomId = oneToOneRoomId(oneToOneId);
    expect(roomById(world, roomId)).toBeDefined();
    const tableId = `${roomId}:table`;

    const caller = world.avatars.find((avatar) => avatar.agentId === 'caller');
    const consultee = world.avatars.find(
      (avatar) => avatar.agentId === 'consultee',
    );
    expect(caller?.target).toEqual({ kind: 'furniture', furnitureId: tableId });
    expect(consultee?.target).toEqual({
      kind: 'furniture',
      furnitureId: tableId,
    });
  });
});
