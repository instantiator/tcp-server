import { describe, expect, it } from 'vitest';

import {
  ARCHIVE_BOOKSHELF_ID,
  createInitialWorld,
  taskRoomId,
} from '../world/layout';
import type { Avatar, OfficeWorld } from '../world/types';
import { addAgentAvatar, avatarById, roomById } from '../world/worldOps';
import type { CompanySnapshot, SnapshotTask } from './companySnapshot';
import { closeTaskRooms, openTaskRooms } from './taskRoomRules';

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

function snapshot(tasks: SnapshotTask[]): CompanySnapshot {
  return { roles: [], tasks, agents: [] };
}

/** Adds an agent avatar to `t1`'s task room, with `carrying`/`dissociatedSeq` at their defaults. */
function addTaskAvatar(
  world: OfficeWorld,
  overrides: Partial<Avatar> = {},
): { world: OfficeWorld; avatarId: string } {
  return addAgentAvatar(world, {
    roleId: 'role-1',
    agentId: 'agent-1',
    assignmentId: 'assignment-1',
    taskId: 't1',
    deskId: null,
    location: { x: 3, y: 3 },
    target: { kind: 'tile', tile: { x: 3, y: 3 } },
    placeAtTarget: false,
    hasRole: true,
    carrying: null,
    dissociatedSeq: null,
    ...overrides,
  });
}

describe('openTaskRooms', () => {
  it('gives an unfinished task a room in the first free slot', () => {
    const world = openTaskRooms(createInitialWorld(), snapshot([task()]));
    const room = roomById(world, taskRoomId('t1'));
    expect(room?.taskId).toBe('t1');
    expect(room?.slot).toBe(3); // slots 0, 1 and 2 are the rec, mail and archive rooms
  });

  it('gives a finished task a room the first time it is seen, until its room is closed', () => {
    const world = openTaskRooms(
      createInitialWorld(),
      snapshot([task({ finished: true, succeeded: true })]),
    );
    expect(roomById(world, taskRoomId('t1'))?.taskId).toBe('t1');
  });

  it('gives a task whose room was closed no room, however it finished', () => {
    const world = openTaskRooms(
      createInitialWorld(),
      snapshot([
        task({
          finished: true,
          visualisationClosedAt: '2026-10-09T10:00:00.000Z',
        }),
      ]),
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
  it('leaves a finished-but-not-succeeded task room open and sends its avatars to the exit, nobody carrying', () => {
    let world = openTaskRooms(createInitialWorld(), snapshot([task()]));
    const created = addTaskAvatar(world);
    world = created.world;

    world = closeTaskRooms(world, snapshot([task({ finished: true })]));

    expect(roomById(world, taskRoomId('t1'))?.closing).toBe(false);
    const avatar = avatarById(world, created.avatarId);
    expect(avatar?.agentId).toBeNull();
    expect(avatar?.assignmentId).toBe('assignment-1'); // kept, not cleared
    expect(avatar?.carrying).toBeNull();
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

  it('leaves an empty finished room open', () => {
    const world = openTaskRooms(createInitialWorld(), snapshot([task()]));
    const finished = closeTaskRooms(
      world,
      snapshot([task({ finished: true, succeeded: true })]),
    );
    expect(roomById(finished, taskRoomId('t1'))?.closing).toBe(false);
    expect(finished.avatars).toEqual([]);
  });

  it('starts closing a finished room once its visualisationClosedAt is set', () => {
    const world = openTaskRooms(createInitialWorld(), snapshot([task()]));
    const closed = closeTaskRooms(
      world,
      snapshot([
        task({
          finished: true,
          succeeded: true,
          visualisationClosedAt: '2026-10-09T10:00:00.000Z',
        }),
      ]),
    );
    expect(roomById(closed, taskRoomId('t1'))?.closing).toBe(true);
    expect(closed.avatars).toEqual([]);
  });

  it('a cancelled (finished, not succeeded) task sends everyone out, nobody carrying', () => {
    let world = openTaskRooms(createInitialWorld(), snapshot([task()]));
    const a = addTaskAvatar(world, { agentId: 'agent-a', dissociatedSeq: 0 });
    world = a.world;
    const b = addTaskAvatar(world, { agentId: 'agent-b' });
    world = b.world;

    world = closeTaskRooms(
      world,
      snapshot([task({ finished: true, succeeded: false })]),
    );

    for (const id of [a.avatarId, b.avatarId]) {
      const avatar = avatarById(world, id);
      expect(avatar?.carrying).toBeNull();
      expect(avatar?.target).toEqual({ kind: 'exit' });
    }
  });

  it('a succeeded task picks the avatar with the highest dissociatedSeq as the carrier', () => {
    let world = openTaskRooms(createInitialWorld(), snapshot([task()]));
    const earlier = addTaskAvatar(world, {
      agentId: null,
      dissociatedSeq: 1,
    });
    world = earlier.world;
    const later = addTaskAvatar(world, {
      agentId: null,
      dissociatedSeq: 5,
    });
    world = later.world;

    world = closeTaskRooms(
      world,
      snapshot([task({ finished: true, succeeded: true })]),
    );

    const carrier = avatarById(world, later.avatarId);
    expect(carrier?.carrying).toBe('outputs');
    expect(carrier?.target).toEqual({
      kind: 'furniture',
      furnitureId: ARCHIVE_BOOKSHELF_ID,
    });

    const other = avatarById(world, earlier.avatarId);
    expect(other?.carrying).toBeNull();
    expect(other?.target).toEqual({ kind: 'exit' });
  });

  it('a succeeded task with nobody dissociated falls back to any avatar with an agent', () => {
    let world = openTaskRooms(createInitialWorld(), snapshot([task()]));
    const created = addTaskAvatar(world); // agentId set, dissociatedSeq null
    world = created.world;

    world = closeTaskRooms(
      world,
      snapshot([task({ finished: true, succeeded: true })]),
    );

    const carrier = avatarById(world, created.avatarId);
    expect(carrier?.agentId).toBeNull();
    expect(carrier?.carrying).toBe('outputs');
    expect(carrier?.target).toEqual({
      kind: 'furniture',
      furnitureId: ARCHIVE_BOOKSHELF_ID,
    });
  });

  it('keeps the carrier on the next rules pass, however it was picked', () => {
    // The fallback pick clears the carrier's agentId, so a second pass that
    // picked afresh would find nobody and send it out without filing.
    let world = openTaskRooms(createInitialWorld(), snapshot([task()]));
    const created = addTaskAvatar(world);
    world = created.world;
    const done = snapshot([task({ finished: true, succeeded: true })]);

    world = closeTaskRooms(closeTaskRooms(world, done), done);

    const carrier = avatarById(world, created.avatarId);
    expect(carrier?.carrying).toBe('outputs');
    expect(carrier?.target).toEqual({
      kind: 'furniture',
      furnitureId: ARCHIVE_BOOKSHELF_ID,
    });
  });
});
