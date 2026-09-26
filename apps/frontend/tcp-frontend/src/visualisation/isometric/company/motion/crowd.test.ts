import { describe, expect, it } from 'vitest';

import {
  CORRIDOR_Y,
  createInitialWorld,
  mapBounds,
  OUTSIDE_X,
  SPAWN_TILE,
} from '../world/layout';
import { renderRegion } from '../world/renderRegion';
import type { Avatar, AvatarTarget, OfficeWorld, Tile } from '../world/types';
import { addAvatar, addRoom, claimDesk, updateAvatar } from '../world/worldOps';
import type { CrowdEvent } from './crowd';
import { Crowd } from './crowd';
import { GHOST_AFTER_MS } from './walker';

/** The static map's walkability, exactly as the scene builds it for the crowd. */
function isWalkableFromWorld(world: OfficeWorld): (tile: Tile) => boolean {
  const bounds = mapBounds(world);
  const region = renderRegion(
    world,
    bounds.x,
    bounds.y,
    bounds.x + bounds.width - 1,
    bounds.y + bounds.height - 1,
  );
  return (tile: Tile): boolean =>
    region.cells[tile.y - region.origin.y]?.[tile.x - region.origin.x]
      ?.walkable ?? false;
}

function manhattan(a: Tile, b: Tile): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function makeAvatar(
  id: string,
  location: Tile,
  target: AvatarTarget,
  overrides: Partial<Avatar> = {},
): Avatar {
  return {
    id,
    kind: 'agent',
    roleId: 'role-1',
    agentId: 'agent-1',
    assignmentId: 'assignment-1',
    taskId: null,
    deskId: null,
    location,
    target,
    placeAtTarget: false,
    ...overrides,
  };
}

/** Runs `crowd.tick(100)` `count` times, collecting every event raised along the way. */
function tickMany(crowd: Crowd, count: number): CrowdEvent[] {
  const events: CrowdEvent[] = [];
  for (let i = 0; i < count; i += 1) {
    events.push(...crowd.tick(100));
  }
  return events;
}

function arrivalsFor(events: readonly CrowdEvent[], avatarId: string) {
  return events.filter(
    (event) => event.kind === 'arrived' && event.avatarId === avatarId,
  );
}

describe('Crowd', () => {
  it('walks a new agent avatar from SPAWN_TILE to a tile beside its desk, arriving exactly once', () => {
    const withRoom = addRoom(createInitialWorld(), 'task', 'task:t1');
    const { world, deskId } = claimDesk(withRoom, 'task:t1', 'agent-avatar:1');
    if (deskId === null) {
      throw new Error('expected a desk');
    }
    const desk = world.furniture.find((item) => item.id === deskId);
    if (desk === undefined) {
      throw new Error('expected the claimed desk');
    }
    const withAvatar = addAvatar(
      world,
      makeAvatar('agent-avatar:1', SPAWN_TILE, {
        kind: 'furniture',
        furnitureId: deskId,
      }),
    );

    const crowd = new Crowd();
    const isWalkable = isWalkableFromWorld(withAvatar);
    const syncEvents = crowd.sync(withAvatar, isWalkable, false);
    expect(syncEvents).toEqual([]);

    const events = tickMany(crowd, 200);
    const arrivals = arrivalsFor(events, 'agent-avatar:1');

    expect(arrivals).toHaveLength(1);
    const arrivedTile =
      arrivals[0]?.kind === 'arrived' ? arrivals[0].tile : undefined;
    expect(arrivedTile).toBeDefined();
    expect(manhattan(arrivedTile as Tile, desk.tile)).toBe(1);
    expect(isWalkable(arrivedTile as Tile)).toBe(true);
  });

  it('placeAtTarget jumps and reports arrival from sync itself', () => {
    const withRoom = addRoom(createInitialWorld(), 'task', 'task:t1');
    const { world, deskId } = claimDesk(withRoom, 'task:t1', 'agent-avatar:1');
    if (deskId === null) {
      throw new Error('expected a desk');
    }
    const desk = world.furniture.find((item) => item.id === deskId);
    if (desk === undefined) {
      throw new Error('expected the claimed desk');
    }
    const withAvatar = addAvatar(
      world,
      makeAvatar(
        'agent-avatar:1',
        SPAWN_TILE,
        { kind: 'furniture', furnitureId: deskId },
        { placeAtTarget: true },
      ),
    );

    const crowd = new Crowd();
    const events = crowd.sync(
      withAvatar,
      isWalkableFromWorld(withAvatar),
      false,
    );

    expect(arrivalsFor(events, 'agent-avatar:1')).toHaveLength(1);
    const position = crowd.positionOf('agent-avatar:1');
    expect(position).toBeDefined();
    expect(manhattan(position as Tile, desk.tile)).toBe(1);
  });

  it('reducedMotion jumps too, even without placeAtTarget', () => {
    const withRoom = addRoom(createInitialWorld(), 'task', 'task:t1');
    const { world, deskId } = claimDesk(withRoom, 'task:t1', 'agent-avatar:1');
    if (deskId === null) {
      throw new Error('expected a desk');
    }
    const withAvatar = addAvatar(
      world,
      makeAvatar('agent-avatar:1', SPAWN_TILE, {
        kind: 'furniture',
        furnitureId: deskId,
      }),
    );

    const crowd = new Crowd();
    const events = crowd.sync(
      withAvatar,
      isWalkableFromWorld(withAvatar),
      true,
    );

    expect(arrivalsFor(events, 'agent-avatar:1')).toHaveLength(1);
  });

  it('reports exited once for an exit target', () => {
    const world = createInitialWorld();
    const withAvatar = addAvatar(
      world,
      makeAvatar('agent-avatar:1', { x: 5, y: CORRIDOR_Y }, { kind: 'exit' }),
    );

    const crowd = new Crowd();
    crowd.sync(withAvatar, isWalkableFromWorld(withAvatar), false);
    const events = tickMany(crowd, 100);

    const exits = events.filter(
      (event) => event.kind === 'exited' && event.avatarId === 'agent-avatar:1',
    );
    expect(exits).toHaveLength(1);
  });

  it('re-routes on a mid-walk target change, and resets the arrival flag', () => {
    const withRoom = addRoom(createInitialWorld(), 'task', 'task:t1');
    const claimedA = claimDesk(withRoom, 'task:t1', 'placeholder-a');
    const claimedB = claimDesk(claimedA.world, 'task:t1', 'placeholder-b');
    if (claimedA.deskId === null || claimedB.deskId === null) {
      throw new Error('expected two desks');
    }
    const deskB = claimedB.world.furniture.find(
      (item) => item.id === claimedB.deskId,
    );
    if (deskB === undefined) {
      throw new Error('expected desk B');
    }

    const world = addAvatar(
      claimedB.world,
      makeAvatar('agent-avatar:1', SPAWN_TILE, {
        kind: 'furniture',
        furnitureId: claimedA.deskId,
      }),
    );

    const crowd = new Crowd();
    const isWalkable = isWalkableFromWorld(world);
    crowd.sync(world, isWalkable, false);

    // A few steps in, but nowhere near arriving at the far desk yet.
    const midWalkEvents = tickMany(crowd, 3);
    expect(arrivalsFor(midWalkEvents, 'agent-avatar:1')).toHaveLength(0);

    const retargeted = updateAvatar(world, 'agent-avatar:1', {
      target: { kind: 'furniture', furnitureId: claimedB.deskId },
    });
    const resyncEvents = crowd.sync(
      retargeted,
      isWalkableFromWorld(retargeted),
      false,
    );
    expect(resyncEvents).toEqual([]);

    const events = tickMany(crowd, 200);
    const arrivals = arrivalsFor(events, 'agent-avatar:1');

    expect(arrivals).toHaveLength(1);
    const arrivedTile =
      arrivals[0]?.kind === 'arrived' ? arrivals[0].tile : undefined;
    expect(manhattan(arrivedTile as Tile, deskB.tile)).toBe(1);
  });

  it('sends two avatars to the same whiteboard to different goal tiles', () => {
    const world = addRoom(createInitialWorld(), 'task', 'task:t1');
    const whiteboard = world.furniture.find(
      (item) => item.kind === 'whiteboard',
    );
    if (whiteboard === undefined) {
      throw new Error('expected a whiteboard');
    }

    const target: AvatarTarget = {
      kind: 'furniture',
      furnitureId: whiteboard.id,
    };
    const withAvatars = addAvatar(
      addAvatar(world, makeAvatar('agent-avatar:1', SPAWN_TILE, target)),
      makeAvatar('agent-avatar:2', SPAWN_TILE, target),
    );

    const crowd = new Crowd();
    // reducedMotion so both goals are visible immediately, via where they land.
    crowd.sync(withAvatars, isWalkableFromWorld(withAvatars), true);

    const positionA = crowd.positionOf('agent-avatar:1');
    const positionB = crowd.positionOf('agent-avatar:2');
    expect(positionA).toBeDefined();
    expect(positionB).toBeDefined();
    expect(positionA).not.toEqual(positionB);
  });

  it('lets two avatars walking towards each other along the corridor both arrive', () => {
    const world = createInitialWorld();
    const outboundTarget: Tile = { x: 5, y: CORRIDOR_Y };
    const inboundTarget: Tile = { x: OUTSIDE_X, y: CORRIDOR_Y };

    const withAvatars = addAvatar(
      addAvatar(
        world,
        makeAvatar('avatar-out', inboundTarget, {
          kind: 'tile',
          tile: outboundTarget,
        }),
      ),
      makeAvatar('avatar-in', outboundTarget, {
        kind: 'tile',
        tile: inboundTarget,
      }),
    );

    const crowd = new Crowd();
    crowd.sync(withAvatars, isWalkableFromWorld(withAvatars), false);

    // Generous enough to walk the corridor and still clear GHOST_AFTER_MS at
    // the single-tile doorway, where no alternate route exists.
    const ticks = Math.ceil(GHOST_AFTER_MS / 100) + 60;
    const events = tickMany(crowd, ticks);

    expect(arrivalsFor(events, 'avatar-out')).toHaveLength(1);
    expect(arrivalsFor(events, 'avatar-in')).toHaveLength(1);
  });

  it("frees a removed avatar's tile for another avatar waiting on it", () => {
    const world = createInitialWorld();
    const contested: Tile = { x: 5, y: CORRIDOR_Y };

    const holder = makeAvatar(
      'holder',
      contested,
      { kind: 'tile', tile: contested },
      { placeAtTarget: true },
    );
    const waiter = makeAvatar(
      'waiter',
      { x: 4, y: CORRIDOR_Y },
      {
        kind: 'tile',
        tile: contested,
      },
    );

    const withBoth = addAvatar(addAvatar(world, holder), waiter);
    const crowd = new Crowd();
    crowd.sync(withBoth, isWalkableFromWorld(withBoth), false);

    // The waiter reaches the tile beside `contested` and is stuck there,
    // well short of anything close to GHOST_AFTER_MS.
    const beforeRemoval = tickMany(crowd, 5);
    expect(arrivalsFor(beforeRemoval, 'waiter')).toHaveLength(0);

    const withoutHolder = {
      ...withBoth,
      avatars: withBoth.avatars.filter((avatar) => avatar.id !== 'holder'),
    };
    crowd.sync(withoutHolder, isWalkableFromWorld(withoutHolder), false);

    const afterRemoval = tickMany(crowd, 10);
    const arrivals = arrivalsFor(afterRemoval, 'waiter');
    expect(arrivals).toHaveLength(1);
    expect(
      arrivals[0]?.kind === 'arrived' ? arrivals[0].tile : undefined,
    ).toEqual(contested);
  });

  it("follows a reviewer's anchor when it moves away", () => {
    const world = createInitialWorld();
    const reviewedTile: Tile = { x: 5, y: CORRIDOR_Y };

    const reviewed = makeAvatar(
      'reviewed',
      reviewedTile,
      { kind: 'tile', tile: reviewedTile },
      { placeAtTarget: true },
    );
    const reviewer = makeAvatar('reviewer', SPAWN_TILE, {
      kind: 'avatar',
      avatarId: 'reviewed',
    });

    const withBoth = addAvatar(addAvatar(world, reviewed), reviewer);
    const crowd = new Crowd();
    crowd.sync(withBoth, isWalkableFromWorld(withBoth), false);

    const firstArrivalEvents = tickMany(crowd, 200);
    const firstArrivals = arrivalsFor(firstArrivalEvents, 'reviewer');
    expect(firstArrivals).toHaveLength(1);
    const firstTile =
      firstArrivals[0]?.kind === 'arrived' ? firstArrivals[0].tile : undefined;
    expect(manhattan(firstTile as Tile, reviewedTile)).toBe(1);

    // The reviewed avatar jumps far away; reducedMotion also lets the
    // reviewer's own follow-up be a jump, keeping the test fast.
    const farTile: Tile = { x: 9, y: CORRIDOR_Y };
    const moved = updateAvatar(withBoth, 'reviewed', {
      target: { kind: 'tile', tile: farTile },
    });
    crowd.sync(moved, isWalkableFromWorld(moved), true);

    const followEvents = tickMany(crowd, 10);
    const followArrivals = arrivalsFor(followEvents, 'reviewer');
    expect(followArrivals).toHaveLength(1);
    const followTile =
      followArrivals[0]?.kind === 'arrived'
        ? followArrivals[0].tile
        : undefined;
    expect(manhattan(followTile as Tile, farTile)).toBe(1);
    expect(followTile).not.toEqual(firstTile);
  });

  it('moves no further in one long tick than in one capped-length tick', () => {
    const world = createInitialWorld();
    const farTarget: Tile = { x: 10, y: CORRIDOR_Y };
    const avatar = makeAvatar(
      'agent-avatar:1',
      { x: 1, y: CORRIDOR_Y },
      {
        kind: 'tile',
        tile: farTarget,
      },
    );
    const withAvatar = addAvatar(world, avatar);
    const isWalkable = isWalkableFromWorld(withAvatar);

    const shortCrowd = new Crowd();
    shortCrowd.sync(withAvatar, isWalkable, false);
    shortCrowd.tick(100);
    const shortPosition = shortCrowd.positionOf('agent-avatar:1');

    const longCrowd = new Crowd();
    longCrowd.sync(withAvatar, isWalkable, false);
    longCrowd.tick(5000);
    const longPosition = longCrowd.positionOf('agent-avatar:1');

    expect(longPosition).toEqual(shortPosition);
  });
});
