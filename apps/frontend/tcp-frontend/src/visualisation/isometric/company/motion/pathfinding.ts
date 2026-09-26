/*
 * A* over the office's tile grid: 4-way moves, unit step cost.
 */

import type { Tile } from '../world/types';

/** One entry on the open list. */
interface OpenEntry {
  readonly tile: Tile;
  /** Cost of the best known route from the start to this tile. */
  readonly g: number;
  /** `g` plus the heuristic: the list is kept sorted by this. */
  readonly f: number;
}

function tileKey(tile: Tile): string {
  return `${tile.x},${tile.y}`;
}

function manhattan(a: Tile, b: Tile): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

// Fixed order so two equal-cost routes always come out the same way.
const NEIGHBOUR_OFFSETS: readonly Tile[] = [
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: 1 },
  { x: 0, y: -1 },
];

// ponytail: sorted-array open list; a binary heap if maps grow past ~2000 tiles
function insertSorted(open: OpenEntry[], entry: OpenEntry): void {
  // Walk back from the end while the neighbour there costs more, so ties
  // keep the order they were discovered in.
  let index = open.length;
  while (index > 0 && open[index - 1].f > entry.f) {
    index -= 1;
  }
  open.splice(index, 0, entry);
}

function reconstruct(cameFrom: ReadonlyMap<string, Tile>, to: Tile): Tile[] {
  const reversed: Tile[] = [];
  let current: Tile | undefined = to;
  while (current !== undefined) {
    reversed.push(current);
    current = cameFrom.get(tileKey(current));
  }
  // The walk above ends at `from`, which the route must not include.
  reversed.pop();
  return reversed.reverse();
}

/**
 * Finds a route from `from` to `to` on a 4-way grid, one step per tile,
 * with a Manhattan heuristic.
 *
 * The caller's `isWalkable` must answer false for every tile outside the
 * map: this search never checks bounds itself. `from` counts as walkable
 * even when `isWalkable(from)` says otherwise, because a map change can put
 * a wall under a standing avatar.
 *
 * The route excludes `from` and includes `to`. `from` equal to `to` gives an
 * empty route. An unwalkable `to`, or no route between them, gives `null`.
 */
export function findPath(
  from: Tile,
  to: Tile,
  isWalkable: (tile: Tile) => boolean,
): Tile[] | null {
  if (from.x === to.x && from.y === to.y) {
    return [];
  }
  if (!isWalkable(to)) {
    return null;
  }

  const open: OpenEntry[] = [{ tile: from, g: 0, f: manhattan(from, to) }];
  const cameFrom = new Map<string, Tile>();
  const gScore = new Map<string, number>([[tileKey(from), 0]]);
  const closed = new Set<string>();

  while (open.length > 0) {
    const current = open.shift();
    if (current === undefined) {
      break;
    }
    const currentKey = tileKey(current.tile);
    if (closed.has(currentKey)) {
      // A stale entry: this tile was reached more cheaply since it was queued.
      continue;
    }
    if (current.tile.x === to.x && current.tile.y === to.y) {
      return reconstruct(cameFrom, to);
    }
    closed.add(currentKey);

    for (const offset of NEIGHBOUR_OFFSETS) {
      const neighbour: Tile = {
        x: current.tile.x + offset.x,
        y: current.tile.y + offset.y,
      };
      const neighbourKey = tileKey(neighbour);
      if (closed.has(neighbourKey) || !isWalkable(neighbour)) {
        continue;
      }
      const tentativeG = current.g + 1;
      const knownG = gScore.get(neighbourKey);
      if (knownG !== undefined && tentativeG >= knownG) {
        continue;
      }
      gScore.set(neighbourKey, tentativeG);
      cameFrom.set(neighbourKey, current.tile);
      insertSorted(open, {
        tile: neighbour,
        g: tentativeG,
        f: tentativeG + manhattan(neighbour, to),
      });
    }
  }

  return null;
}
