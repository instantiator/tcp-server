import {
  CORRIDOR_Y,
  corridorBounds,
  FIRST_SLOT_X,
  mapBounds,
  OUTSIDE_X,
  ROOM_WIDTH,
} from './layout';
import type {
  Bounds,
  Cell,
  Mob,
  OfficeWorld,
  Region,
  RoomPurpose,
  Tile,
} from './types';

function insideBounds(bounds: Bounds, x: number, y: number): boolean {
  return (
    x >= bounds.x &&
    x < bounds.x + bounds.width &&
    y >= bounds.y &&
    y < bounds.y + bounds.height
  );
}

function isPerimeter(bounds: Bounds, x: number, y: number): boolean {
  return (
    x === bounds.x ||
    x === bounds.x + bounds.width - 1 ||
    y === bounds.y ||
    y === bounds.y + bounds.height - 1
  );
}

/**
 * A tile's floor and wall, in the order the plan lays the rules out. The
 * first matching rule decides the tile; {@link cellAt} adds furniture on top
 * to work out `walkable`.
 */
function floorAndWall(
  world: OfficeWorld,
  x: number,
  y: number,
): { floor: RoomPurpose | 'outside' | null; wall: boolean } {
  // 1. off the map entirely.
  if (!insideBounds(mapBounds(world), x, y)) {
    return { floor: null, wall: false };
  }

  // 2. the outside tiles, where avatars spawn and where `exit` resolves to.
  if (x === OUTSIDE_X && (y === CORRIDOR_Y || y === CORRIDOR_Y + 1)) {
    return { floor: 'outside', wall: false };
  }

  // 3. inside a room other than the corridor: its perimeter is wall, except
  // for its own door gap.
  const room = world.rooms.find(
    (candidate) =>
      candidate.purpose !== 'corridor' && insideBounds(candidate.bounds, x, y),
  );
  if (room !== undefined) {
    const onPerimeter = isPerimeter(room.bounds, x, y);
    const onDoor = room.door !== null && room.door.x === x && room.door.y === y;
    return { floor: room.purpose, wall: onPerimeter && !onDoor };
  }

  // 4. the door frame beside the office door: wall, even though it falls
  // inside the corridor's own bounds.
  if (x === 1 && y === CORRIDOR_Y + 1) {
    return { floor: 'corridor', wall: true };
  }

  // 5. the corridor floor itself.
  if (insideBounds(corridorBounds(world.corridorColumns), x, y)) {
    return { floor: 'corridor', wall: false };
  }

  const endX = FIRST_SLOT_X + world.corridorColumns * ROOM_WIDTH - 1;

  // 6. the corridor's edge rows, walled where no room claimed the tile.
  if ((y === CORRIDOR_Y - 1 || y === CORRIDOR_Y + 2) && x >= 1 && x <= endX) {
    return { floor: 'corridor', wall: true };
  }

  // 7. the wall closing the corridor's east end.
  if (x === endX + 1 && y >= CORRIDOR_Y - 1 && y <= CORRIDOR_Y + 2) {
    return { floor: 'corridor', wall: true };
  }

  // 8. nothing here.
  return { floor: null, wall: false };
}

function cellAt(world: OfficeWorld, x: number, y: number): Cell {
  const { floor, wall } = floorAndWall(world, x, y);
  const furnitureHere = world.furniture.filter(
    (item) => item.tile.x === x && item.tile.y === y,
  );
  const walkable =
    floor !== null &&
    !wall &&
    furnitureHere.every((item) => item.kind === 'officeDoor');
  return { floor, wall, walkable };
}

/**
 * Renders the rectangle between the two corners, both included, regardless
 * of which order they come in. A tile outside the map comes back empty
 * rather than being left out.
 */
export function renderRegion(
  world: OfficeWorld,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): Region {
  const minX = Math.min(x1, x2);
  const maxX = Math.max(x1, x2);
  const minY = Math.min(y1, y2);
  const maxY = Math.max(y1, y2);

  const cells: Cell[][] = [];
  for (let y = minY; y <= maxY; y += 1) {
    const row: Cell[] = [];
    for (let x = minX; x <= maxX; x += 1) {
      row.push(cellAt(world, x, y));
    }
    cells.push(row);
  }

  const inRegion = (tile: Tile): boolean =>
    tile.x >= minX && tile.x <= maxX && tile.y >= minY && tile.y <= maxY;

  const mobs: Mob[] = [
    ...world.furniture
      .filter((furniture) => inRegion(furniture.tile))
      .map((furniture): Mob => ({ kind: 'furniture', furniture })),
    ...world.avatars
      .filter((avatar) => inRegion(avatar.location))
      .map((avatar): Mob => ({ kind: 'avatar', avatar })),
  ];

  return { origin: { x: minX, y: minY }, cells, mobs };
}
