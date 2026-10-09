import { describe, expect, it } from 'vitest';
import {
  createInitialWorld,
  CORRIDOR_ID,
  oneToOneRoomId,
  taskRoomId,
} from '../world/layout';
import type { OfficeWorld, Tile } from '../world/types';
import { addAgentAvatar, addRoom, furnitureById } from '../world/worldOps';
import type {
  CompanySnapshot,
  SnapshotAgent,
  SnapshotTask,
} from './companySnapshot';
import { furnitureIsLit, roomLighting, tileIsLit } from './roomLighting';

function task(overrides: Partial<SnapshotTask> = {}): SnapshotTask {
  return {
    id: 't1',
    shortcode: 'T1',
    request: 'Do the thing',
    finished: false,
    succeeded: false,
    status: 'in-progress',
    pausedAt: null,
    visualisationClosedAt: null,
    step: 0,
    steps: 0,
    ...overrides,
  };
}

function agent(overrides: Partial<SnapshotAgent> = {}): SnapshotAgent {
  return {
    id: 'agent-1',
    roleId: 'role-1',
    assignmentId: 'assignment-1',
    taskId: 't1',
    status: 'running',
    activity: { kind: 'working' },
    ...overrides,
  };
}

function snapshot(
  tasks: SnapshotTask[],
  agents: SnapshotAgent[] = [],
): CompanySnapshot {
  return { roles: [], tasks, agents };
}

/** A world with `t1`'s room, and one avatar for `agent-1` standing on `location`. */
function worldWithAvatarAt(
  location: (world: OfficeWorld) => Tile,
): OfficeWorld {
  const world = addRoom(createInitialWorld(), 'task', taskRoomId('t1'), 't1');
  return addAgentAvatar(world, {
    roleId: 'role-1',
    agentId: 'agent-1',
    assignmentId: 'assignment-1',
    taskId: 't1',
    deskId: null,
    location: location(world),
    target: { kind: 'tile', tile: location(world) },
    placeAtTarget: true,
    hasRole: true,
    carrying: null,
    dissociatedSeq: null,
  }).world;
}

/** A tile inside a room's bounds, clear of its walls. */
function insideRoom(world: OfficeWorld, roomId: string): Tile {
  const room = world.rooms.find((candidate) => candidate.id === roomId);
  if (room === undefined) throw new Error(`no room ${roomId}`);
  return { x: room.bounds.x + 1, y: room.bounds.y + 1 };
}

describe('roomLighting', () => {
  it('leaves an empty room dim', () => {
    const world = addRoom(createInitialWorld(), 'task', taskRoomId('t1'), 't1');
    const { litRooms } = roomLighting(world, snapshot([task()]));
    expect(litRooms.has(taskRoomId('t1'))).toBe(false);
  });

  it('lights a room with a running agent in it, and only that room', () => {
    const world = worldWithAvatarAt((w) => insideRoom(w, taskRoomId('t1')));
    const { litRooms } = roomLighting(world, snapshot([task()], [agent()]));
    expect(litRooms.has(taskRoomId('t1'))).toBe(true);
    expect(litRooms.has('rec')).toBe(false);
  });

  it('keeps a room dim when only a paused agent is in it', () => {
    const world = worldWithAvatarAt((w) => insideRoom(w, taskRoomId('t1')));
    const { litRooms } = roomLighting(
      world,
      snapshot([task()], [agent({ status: 'paused' })]),
    );
    expect(litRooms.has(taskRoomId('t1'))).toBe(false);
  });

  it('lights the rec room for a running agent standing in it', () => {
    const world = worldWithAvatarAt((w) => insideRoom(w, 'rec'));
    const { litRooms } = roomLighting(world, snapshot([task()], [agent()]));
    expect(litRooms.has('rec')).toBe(true);
    expect(litRooms.has(taskRoomId('t1'))).toBe(false);
  });

  it('lights a one-to-one room by the same rule', () => {
    const roomId = oneToOneRoomId('consult-1');
    const world = addRoom(createInitialWorld(), 'oneToOne', roomId);
    const withAvatar = addAgentAvatar(world, {
      roleId: 'role-1',
      agentId: 'agent-1',
      assignmentId: 'assignment-1',
      taskId: null,
      deskId: null,
      location: insideRoom(world, roomId),
      target: { kind: 'tile', tile: insideRoom(world, roomId) },
      placeAtTarget: true,
      hasRole: true,
      carrying: null,
      dissociatedSeq: null,
    }).world;
    const lit = roomLighting(
      withAvatar,
      snapshot([], [agent({ taskId: null })]),
    );
    expect(lit.litRooms.has(roomId)).toBe(true);
    expect(roomLighting(withAvatar, snapshot([])).litRooms.has(roomId)).toBe(
      false,
    );
  });

  it('always lights the corridor', () => {
    const { litRooms } = roomLighting(createInitialWorld(), snapshot([]));
    expect(litRooms.has(CORRIDOR_ID)).toBe(true);
  });

  it.each(['planning', 'in-progress', 'finalising'] as const)(
    'lights the board of a task that is %s',
    (status) => {
      const world = addRoom(
        createInitialWorld(),
        'task',
        taskRoomId('t1'),
        't1',
      );
      const { litBoards } = roomLighting(world, snapshot([task({ status })]));
      expect(litBoards.has('t1')).toBe(true);
    },
  );

  it.each(['ready', 'succeeded', 'failed', 'cancelled'] as const)(
    'leaves the board of a %s task dim',
    (status) => {
      const world = addRoom(
        createInitialWorld(),
        'task',
        taskRoomId('t1'),
        't1',
      );
      const { litBoards } = roomLighting(world, snapshot([task({ status })]));
      expect(litBoards.has('t1')).toBe(false);
    },
  );

  it('leaves the board of a paused task dim', () => {
    const world = addRoom(createInitialWorld(), 'task', taskRoomId('t1'), 't1');
    const { litBoards } = roomLighting(
      world,
      snapshot([task({ pausedAt: '2026-10-09T10:00:00.000Z' })]),
    );
    expect(litBoards.has('t1')).toBe(false);
  });
});

describe('tileIsLit and furnitureIsLit', () => {
  const world = addRoom(createInitialWorld(), 'task', taskRoomId('t1'), 't1');
  const dark = { litRooms: new Set<string>(), litBoards: new Set<string>() };
  const roomTile = insideRoom(world, taskRoomId('t1'));

  it('dims a tile in an unlit room, and lights it once the room is lit', () => {
    expect(tileIsLit(world, dark, roomTile)).toBe(false);
    expect(
      tileIsLit(
        world,
        { ...dark, litRooms: new Set([taskRoomId('t1')]) },
        roomTile,
      ),
    ).toBe(true);
  });

  it('always lights corridor and outside tiles', () => {
    expect(tileIsLit(world, dark, { x: 0, y: 0 })).toBe(true);
  });

  it("lights a whiteboard by its task's board, not its room", () => {
    const board = furnitureById(world, `${taskRoomId('t1')}:whiteboard`);
    if (board === undefined) throw new Error('expected a whiteboard');
    const roomLit = { ...dark, litRooms: new Set([taskRoomId('t1')]) };
    expect(furnitureIsLit(world, roomLit, board)).toBe(false);
    expect(
      furnitureIsLit(world, { ...dark, litBoards: new Set(['t1']) }, board),
    ).toBe(true);
  });
});
