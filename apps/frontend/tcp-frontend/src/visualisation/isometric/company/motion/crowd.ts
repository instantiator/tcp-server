/*
 * Keeping every avatar's walker in step with the world. React decides what
 * each avatar is heading for; this is what turns that into a route, moves
 * the walker along it frame by frame, and says when an avatar has arrived or
 * left. Nothing here is Phaser-specific — the scene just draws where
 * `positionOf` says an avatar is.
 */

import type { AvatarTarget, OfficeWorld, Tile } from '../world/types';
import { sameTarget, sameTile } from '../world/worldOps';
import { findPath } from './pathfinding';
import { resolveTarget } from './targetTiles';
import type { TargetEnv } from './targetTiles';
import type { Walker } from './walker';
import {
  advanceWalker,
  createWalker,
  planningTile,
  REROUTE_MS,
  setRoute,
} from './walker';

/** Something the scene should tell React about: an arrival, or a departure. */
export type CrowdEvent =
  | { readonly kind: 'arrived'; readonly avatarId: string; readonly tile: Tile }
  | { readonly kind: 'exited'; readonly avatarId: string };

/** One avatar's walking state, kept between calls. */
interface AvatarState {
  walker: Walker;
  target: AvatarTarget;
  /** The tile `target` last resolved to, or `null` while unresolved. */
  goal: Tile | null;
  /** Arrival (or exit) has already been reported for the current `target`. */
  arrived: boolean;
  /** `target` couldn't be turned into a route; retried every `REROUTE_MS`. */
  pendingPlan: boolean;
  /** Time since the last retry of an unresolved plan. */
  retryMs: number;
  /** Time since the last check that an `avatar` target hasn't wandered off. */
  anchorRecheckMs: number;
}

function manhattan(a: Tile, b: Tile): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

/**
 * Every avatar's live position and route. `sync` brings it in line with a
 * new world (new avatars, changed targets, a changed map); `tick` walks time
 * forward. Both read and write the same per-avatar state, so a caller must
 * use one `Crowd` for the whole session rather than building a fresh one
 * per frame.
 */
export class Crowd {
  private readonly avatars = new Map<string, AvatarState>();
  private lastLayoutVersion: number | null = null;
  private world: OfficeWorld | null = null;
  private isWalkableStatic: (tile: Tile) => boolean = () => false;
  private reducedMotion = false;

  /** Brings walkers in line with the world. `isWalkable` is the static map. */
  sync(
    world: OfficeWorld,
    isWalkable: (tile: Tile) => boolean,
    reducedMotion: boolean,
  ): CrowdEvent[] {
    const events: CrowdEvent[] = [];
    const layoutChanged =
      this.lastLayoutVersion !== null &&
      this.lastLayoutVersion !== world.layoutVersion;

    this.world = world;
    this.isWalkableStatic = isWalkable;
    this.reducedMotion = reducedMotion;
    this.lastLayoutVersion = world.layoutVersion;

    const seen = new Set<string>();

    for (const avatar of world.avatars) {
      seen.add(avatar.id);
      const existing = this.avatars.get(avatar.id);

      if (existing === undefined) {
        const state: AvatarState = {
          walker: createWalker(avatar.location),
          target: avatar.target,
          goal: null,
          arrived: false,
          pendingPlan: false,
          retryMs: 0,
          anchorRecheckMs: 0,
        };
        this.avatars.set(avatar.id, state);
        if (avatar.placeAtTarget || reducedMotion) {
          this.jumpToTarget(avatar.id, state, events);
        } else {
          this.plan(avatar.id, state, events);
        }
        continue;
      }

      if (!sameTarget(existing.target, avatar.target)) {
        existing.target = avatar.target;
        existing.arrived = false;
        existing.goal = null;
        existing.pendingPlan = false;
        existing.retryMs = 0;
        existing.anchorRecheckMs = 0;
        this.planOrJump(avatar.id, existing, events);
      } else if (layoutChanged && !existing.arrived) {
        this.planOrJump(avatar.id, existing, events);
      }
    }

    for (const id of [...this.avatars.keys()]) {
      if (!seen.has(id)) {
        this.avatars.delete(id);
      }
    }

    return events;
  }

  /** Advances every walker by `deltaMs`. */
  tick(deltaMs: number): CrowdEvent[] {
    // ponytail: a long frame (tab in background) is treated as 100ms; avatars pause rather than teleport
    const cappedDelta = Math.min(deltaMs, 100);
    const events: CrowdEvent[] = [];
    if (this.world === null) {
      return events;
    }

    for (const [id, state] of this.avatars) {
      const isBlocked = (tile: Tile): boolean => this.isBlockedFor(id, tile);
      const update = advanceWalker(state.walker, cappedDelta, isBlocked);
      state.walker = update.walker;

      if (update.arrived) {
        this.reportArrival(id, state, events);
      } else if (update.needsReplan) {
        this.replan(id, state);
      }

      if (!state.arrived && state.pendingPlan) {
        state.retryMs += cappedDelta;
        if (state.retryMs >= REROUTE_MS) {
          state.retryMs = 0;
          this.planOrJump(id, state, events);
        }
      }

      if (state.arrived && state.target.kind === 'avatar') {
        state.anchorRecheckMs += cappedDelta;
        if (state.anchorRecheckMs >= REROUTE_MS) {
          state.anchorRecheckMs = 0;
          const anchorTile = this.avatars.get(state.target.avatarId)?.walker
            .tile;
          if (
            anchorTile !== undefined &&
            manhattan(state.walker.tile, anchorTile) > 1
          ) {
            state.arrived = false;
            this.planOrJump(id, state, events);
          }
        }
      }
    }

    return events;
  }

  /** Tile-space position for drawing. */
  positionOf(
    avatarId: string,
  ): { readonly x: number; readonly y: number } | undefined {
    return this.avatars.get(avatarId)?.walker.position;
  }

  private planOrJump(
    id: string,
    state: AvatarState,
    events: CrowdEvent[],
  ): void {
    if (this.reducedMotion) {
      this.jumpToTarget(id, state, events);
    } else {
      this.plan(id, state, events);
    }
  }

  private envFor(id: string): TargetEnv {
    return {
      isWalkable: this.isWalkableStatic,
      isFree: (tile: Tile) => this.isFreeFor(id, tile),
      liveTileOf: (avatarId: string) => this.avatars.get(avatarId)?.walker.tile,
    };
  }

  /** Resolves a goal and routes to it over the static map only. */
  private plan(id: string, state: AvatarState, events: CrowdEvent[]): void {
    const world = this.world;
    if (world === null) {
      return;
    }

    const goal = resolveTarget(state.target, world, this.envFor(id));
    state.goal = goal;

    if (goal === null) {
      state.pendingPlan = true;
      return;
    }

    if (sameTile(state.walker.tile, goal) && !state.walker.stepping) {
      state.walker = { ...state.walker, route: [] };
      state.pendingPlan = false;
      this.reportArrival(id, state, events);
      return;
    }

    const route = findPath(
      planningTile(state.walker),
      goal,
      this.isWalkableStatic,
    );
    if (route === null) {
      state.pendingPlan = true;
      return;
    }
    state.walker = setRoute(state.walker, route);
    state.pendingPlan = false;
  }

  /** Resolves a goal and puts the walker straight there, for reduced motion and page load. */
  private jumpToTarget(
    id: string,
    state: AvatarState,
    events: CrowdEvent[],
  ): void {
    const world = this.world;
    if (world === null) {
      return;
    }

    const goal = resolveTarget(state.target, world, this.envFor(id));
    state.goal = goal;

    if (goal === null) {
      state.pendingPlan = true;
      return;
    }

    state.walker = createWalker(goal);
    state.pendingPlan = false;
    this.reportArrival(id, state, events);
  }

  /**
   * Re-routes a blocked walker to its existing goal, treating other walkers'
   * tiles as walls (the goal itself excepted). Leaves the walker be if that
   * finds nothing — it will ghost through once it has waited long enough.
   */
  private replan(id: string, state: AvatarState): void {
    const goal = state.goal;
    if (goal === null) {
      return;
    }

    const isWalkableStatic = this.isWalkableStatic;
    const isWalkableAroundOthers = (tile: Tile): boolean => {
      if (sameTile(tile, goal)) {
        return isWalkableStatic(tile);
      }
      return isWalkableStatic(tile) && this.isFreeFor(id, tile);
    };

    const route = findPath(
      planningTile(state.walker),
      goal,
      isWalkableAroundOthers,
    );
    if (route !== null) {
      state.walker = setRoute(state.walker, route);
    }
  }

  private reportArrival(
    id: string,
    state: AvatarState,
    events: CrowdEvent[],
  ): void {
    if (state.arrived) {
      return;
    }
    state.arrived = true;
    events.push(
      state.target.kind === 'exit'
        ? { kind: 'exited', avatarId: id }
        : { kind: 'arrived', avatarId: id, tile: state.walker.tile },
    );
  }

  /** No other avatar holds, reserves or has claimed `tile` as its goal. */
  private isFreeFor(id: string, tile: Tile): boolean {
    for (const [otherId, other] of this.avatars) {
      if (otherId === id) {
        continue;
      }
      if (sameTile(other.walker.tile, tile)) {
        return false;
      }
      if (other.walker.stepping && sameTile(other.walker.route[0], tile)) {
        return false;
      }
      if (other.goal !== null && sameTile(other.goal, tile)) {
        return false;
      }
    }
    return true;
  }

  /** No other avatar holds or reserves `tile` right now. Ignores claimed goals. */
  private isBlockedFor(id: string, tile: Tile): boolean {
    for (const [otherId, other] of this.avatars) {
      if (otherId === id) {
        continue;
      }
      if (sameTile(other.walker.tile, tile)) {
        return true;
      }
      if (other.walker.stepping && sameTile(other.walker.route[0], tile)) {
        return true;
      }
    }
    return false;
  }
}
