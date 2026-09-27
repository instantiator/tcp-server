import { describe, expect, it } from 'vitest';

import { addAgentAvatar, avatarById, roomById } from '../world/worldOps';
import { createInitialWorld, taskRoomId } from '../world/layout';
import type { CompanySnapshot, SnapshotTask } from './companySnapshot';
import { closeTaskRooms, openTaskRooms } from './taskRoomRules';

function task(overrides: Partial<SnapshotTask> = {}): SnapshotTask {
  return {
    id: 't1',
    shortcode: 'T1',
    request: 'Do the thing',
    finished: false,
    step: 0,
    steps: 0,
    ...overrides,
  };
}

function snapshot(tasks: SnapshotTask[]): CompanySnapshot {
  return { roles: [], tasks, agents: [] };
}

describe('openTaskRooms', () => {
  it('gives an unfinished task a room in the first free slot', () => {
    const world = openTaskRooms(createInitialWorld(), snapshot([task()]));
    const room = roomById(world, taskRoomId('t1'));
    expect(room?.taskId).toBe('t1');
    expect(room?.slot).toBe(2); // slots 0 and 1 are the rec and mail rooms
  });

  it('never gives a finished task a room, even the first time it is seen', () => {
    const world = openTaskRooms(
      createInitialWorld(),
      snapshot([task({ finished: true })]),
    );
    expect(roomById(world, taskRoomId('t1'))).toBeUndefined();
  });

  it('is reference-stable once the task already has its room', () => {
    const world = openTaskRooms(createInitialWorld(), snapshot([task()]));
    const again = openTaskRooms(world, snapshot([task()]));
    expect(again).toBe(world);
  });
});

describe('closeTaskRooms', () => {
  it('closes a finished task room and sends its avatars to the exit', () => {
    let world = openTaskRooms(createInitialWorld(), snapshot([task()]));
    const created = addAgentAvatar(world, {
      roleId: 'role-1',
      agentId: 'agent-1',
      assignmentId: 'assignment-1',
      taskId: 't1',
      deskId: null,
      location: { x: 3, y: 3 },
      target: { kind: 'tile', tile: { x: 3, y: 3 } },
      placeAtTarget: false,
      hasRole: true,
    });
    world = created.world;

    world = closeTaskRooms(world, snapshot([task({ finished: true })]));

    expect(roomById(world, taskRoomId('t1'))?.closing).toBe(true);
    const avatar = avatarById(world, created.avatarId);
    expect(avatar?.agentId).toBeNull();
    expect(avatar?.assignmentId).toBe('assignment-1'); // kept, not cleared
    expect(avatar?.target).toEqual({ kind: 'exit' });
  });

  it('closes a room whose task has left the snapshot entirely', () => {
    let world = openTaskRooms(createInitialWorld(), snapshot([task()]));
    world = closeTaskRooms(world, snapshot([]));
    expect(roomById(world, taskRoomId('t1'))?.closing).toBe(true);
  });

  it('is reference-stable when nothing needs closing', () => {
    const world = openTaskRooms(createInitialWorld(), snapshot([task()]));
    const again = closeTaskRooms(world, snapshot([task()]));
    expect(again).toBe(world);
  });
});
