import { describe, expect, it } from 'vitest';

import {
  GHOST_AFTER_MS,
  REROUTE_MS,
  WALK_TILES_PER_SECOND,
  advanceWalker,
  createWalker,
  planningTile,
  setRoute,
} from './walker';

const notBlocked = () => false;
const alwaysBlocked = () => true;

describe('createWalker', () => {
  it('stands still on the tile with an empty route', () => {
    const walker = createWalker({ x: 2, y: 3 });

    expect(walker.tile).toEqual({ x: 2, y: 3 });
    expect(walker.position).toEqual({ x: 2, y: 3 });
    expect(walker.route).toEqual([]);
    expect(walker.stepping).toBe(false);
    expect(walker.blockedMs).toBe(0);
  });
});

describe('planningTile', () => {
  it('returns the standing tile when not stepping', () => {
    expect(planningTile(createWalker({ x: 2, y: 2 }))).toEqual({ x: 2, y: 2 });
  });

  it('returns route[0], the already-reserved tile, while stepping', () => {
    const stepping = advanceWalker(
      setRoute(createWalker({ x: 0, y: 0 }), [{ x: 1, y: 0 }]),
      50,
      notBlocked,
    ).walker;

    expect(stepping.stepping).toBe(true);
    expect(planningTile(stepping)).toEqual({ x: 1, y: 0 });
  });
});

describe('setRoute', () => {
  it('replaces the route outright when not stepping, and keeps blockedMs', () => {
    const blocked = advanceWalker(
      setRoute(createWalker({ x: 0, y: 0 }), [{ x: 1, y: 0 }]),
      100,
      alwaysBlocked,
    ).walker;
    expect(blocked.blockedMs).toBe(100);

    const rerouted = setRoute(blocked, [{ x: 0, y: 1 }]);

    expect(rerouted.route).toEqual([{ x: 0, y: 1 }]);
    // Carried over, so a walker that re-plans while blocked still ghosts.
    expect(rerouted.blockedMs).toBe(100);
    expect(rerouted.stepping).toBe(false);
  });

  it('keeps the step already under way, and puts the new route after it', () => {
    const stepping = advanceWalker(
      setRoute(createWalker({ x: 0, y: 0 }), [{ x: 5, y: 0 }]),
      100,
      notBlocked,
    ).walker;
    expect(stepping.stepping).toBe(true);

    const rerouted = setRoute(stepping, [
      { x: 6, y: 0 },
      { x: 7, y: 0 },
    ]);

    expect(rerouted.route).toEqual([
      { x: 5, y: 0 },
      { x: 6, y: 0 },
      { x: 7, y: 0 },
    ]);
    expect(rerouted.stepping).toBe(true);
  });

  it('never mutates the walker it is given', () => {
    const walker = createWalker({ x: 0, y: 0 });
    const snapshot = { ...walker };

    setRoute(walker, [{ x: 1, y: 0 }]);

    expect(walker).toEqual(snapshot);
  });
});

describe('advanceWalker', () => {
  it('does nothing with an empty route', () => {
    const walker = createWalker({ x: 1, y: 1 });
    const update = advanceWalker(walker, 1000, notBlocked);

    expect(update.walker).toEqual(walker);
    expect(update.arrived).toBe(false);
    expect(update.needsReplan).toBe(false);
  });

  it('moves WALK_TILES_PER_SECOND tiles per 1000ms', () => {
    // A distant waypoint so the step doesn't finish partway through, which
    // would let snapping mask the speed being measured.
    const walker = setRoute(createWalker({ x: 0, y: 0 }), [{ x: 5, y: 0 }]);
    const update = advanceWalker(walker, 1000, notBlocked);

    expect(update.walker.position).toEqual({ x: WALK_TILES_PER_SECOND, y: 0 });
    expect(update.walker.stepping).toBe(true);
  });

  it('reserves route[0] while stepping, showing the tile is taken', () => {
    const walker = setRoute(createWalker({ x: 0, y: 0 }), [{ x: 5, y: 0 }]);
    const update = advanceWalker(walker, 100, notBlocked);

    expect(update.walker.stepping).toBe(true);
    expect(update.walker.route[0]).toEqual({ x: 5, y: 0 });
  });

  it('arrives exactly once, then stays put with arrived: false', () => {
    const walker = setRoute(createWalker({ x: 0, y: 0 }), [{ x: 1, y: 0 }]);

    const first = advanceWalker(walker, 1000, notBlocked);
    expect(first.arrived).toBe(true);
    expect(first.walker.tile).toEqual({ x: 1, y: 0 });
    expect(first.walker.route).toEqual([]);
    expect(first.walker.stepping).toBe(false);

    const second = advanceWalker(first.walker, 1000, notBlocked);
    expect(second.arrived).toBe(false);
    expect(second.walker).toEqual(first.walker);
  });

  it('drops any leftover distance once the target tile is reached', () => {
    // 1000ms covers WALK_TILES_PER_SECOND (3) tiles, well past the single
    // 1-tile step; the walker still lands exactly on the tile, not beyond it.
    const walker = setRoute(createWalker({ x: 0, y: 0 }), [{ x: 1, y: 0 }]);
    const update = advanceWalker(walker, 1000, notBlocked);

    expect(update.walker.position).toEqual({ x: 1, y: 0 });
  });

  it('waits when blocked, with the position unchanged', () => {
    const walker = setRoute(createWalker({ x: 0, y: 0 }), [{ x: 1, y: 0 }]);
    const update = advanceWalker(walker, 100, alwaysBlocked);

    expect(update.walker.position).toEqual({ x: 0, y: 0 });
    expect(update.walker.stepping).toBe(false);
    expect(update.walker.blockedMs).toBe(100);
    expect(update.arrived).toBe(false);
  });

  it('asks to re-plan at REROUTE_MS and again at 2 * REROUTE_MS, not between', () => {
    let walker = setRoute(createWalker({ x: 0, y: 0 }), [{ x: 1, y: 0 }]);
    const step = REROUTE_MS / 3;
    const replans: boolean[] = [];

    for (let i = 0; i < 6; i += 1) {
      const update = advanceWalker(walker, step, alwaysBlocked);
      walker = update.walker;
      replans.push(update.needsReplan);
    }

    expect(replans).toEqual([false, false, true, false, false, true]);
    expect(walker.blockedMs).toBe(2 * REROUTE_MS);
  });

  it('walks through a blocked tile once blockedMs reaches GHOST_AFTER_MS', () => {
    const walker = setRoute(createWalker({ x: 0, y: 0 }), [{ x: 1, y: 0 }]);

    const stillWaiting = advanceWalker(walker, GHOST_AFTER_MS, alwaysBlocked);
    expect(stillWaiting.walker.stepping).toBe(false);
    expect(stillWaiting.walker.blockedMs).toBe(GHOST_AFTER_MS);

    const ghosts = advanceWalker(stillWaiting.walker, 100, alwaysBlocked);
    expect(ghosts.walker.stepping).toBe(true);
  });

  it('still ghosts when the scene re-plans every time it is asked to', () => {
    // The scene answers each `needsReplan` with a new route; if that reset the
    // blocked time, a walker boxed in for good would never escape.
    let walker = setRoute(createWalker({ x: 0, y: 0 }), [{ x: 1, y: 0 }]);
    for (let elapsed = 0; elapsed < GHOST_AFTER_MS; elapsed += 100) {
      const update = advanceWalker(walker, 100, alwaysBlocked);
      walker = update.needsReplan
        ? setRoute(update.walker, [{ x: 1, y: 0 }])
        : update.walker;
    }

    expect(advanceWalker(walker, 100, alwaysBlocked).walker.stepping).toBe(
      true,
    );
  });

  it('never mutates the walker it is given', () => {
    const walker = setRoute(createWalker({ x: 0, y: 0 }), [{ x: 1, y: 0 }]);
    const snapshot = { ...walker, position: { ...walker.position } };

    advanceWalker(walker, 100, notBlocked);

    expect(walker).toEqual(snapshot);
  });
});
