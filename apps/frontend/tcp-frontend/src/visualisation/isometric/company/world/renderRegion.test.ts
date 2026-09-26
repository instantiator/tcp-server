import { describe, expect, it } from 'vitest';

import { addRoom, claimDesk } from './worldOps';
import { CORRIDOR_Y, createInitialWorld, mapBounds } from './layout';
import { renderRegion } from './renderRegion';

describe('renderRegion', () => {
  it('renders a 1x1 region at the given tile', () => {
    const world = createInitialWorld();
    const region = renderRegion(world, 2, 0, 2, 0); // rec room's top-left corner

    expect(region.origin).toEqual({ x: 2, y: 0 });
    expect(region.cells).toHaveLength(1);
    expect(region.cells[0]).toHaveLength(1);
    expect(region.cells[0]?.[0]).toEqual({
      floor: 'rec',
      wall: true,
      walkable: false,
    });
  });

  it('renders the whole map without throwing, and clips nothing inside it', () => {
    const world = createInitialWorld();
    const bounds = mapBounds(world);
    const region = renderRegion(
      world,
      bounds.x,
      bounds.y,
      bounds.x + bounds.width - 1,
      bounds.y + bounds.height - 1,
    );

    expect(region.cells).toHaveLength(bounds.height);
    expect(region.cells[0]).toHaveLength(bounds.width);
  });

  it('gives empty cells for a region partly off the map', () => {
    const world = createInitialWorld();
    const region = renderRegion(world, -2, CORRIDOR_Y, 0, CORRIDOR_Y);

    expect(region.origin).toEqual({ x: -2, y: CORRIDOR_Y });
    expect(region.cells[0]?.[0]).toEqual({
      floor: null,
      wall: false,
      walkable: false,
    });
    // x = 0 is the outside tile, on the map, on a corridor row.
    expect(region.cells[0]?.[2]).toEqual({
      floor: 'outside',
      wall: false,
      walkable: true,
    });
  });

  it('normalises reversed corners the same as ordered ones', () => {
    const world = createInitialWorld();
    const forward = renderRegion(world, 2, 0, 4, 2);
    const reversed = renderRegion(world, 4, 2, 2, 0);

    expect(reversed).toEqual(forward);
  });

  it('makes the door gap walkable, and the wall beside it not', () => {
    const world = createInitialWorld();
    const rec = world.rooms.find((room) => room.id === 'rec');
    if (rec?.door === null || rec === undefined) {
      throw new Error('expected the rec room to have a door');
    }

    const doorCell = renderRegion(
      world,
      rec.door.x,
      rec.door.y,
      rec.door.x,
      rec.door.y,
    ).cells[0]?.[0];
    expect(doorCell).toEqual({ floor: 'rec', wall: false, walkable: true });

    const besideDoor = renderRegion(
      world,
      rec.door.x + 1,
      rec.door.y,
      rec.door.x + 1,
      rec.door.y,
    ).cells[0]?.[0];
    expect(besideDoor).toEqual({ floor: 'rec', wall: true, walkable: false });
  });

  it('marks the outside tiles at x = 0 on both corridor rows', () => {
    const world = createInitialWorld();
    const region = renderRegion(world, 0, CORRIDOR_Y, 0, CORRIDOR_Y + 1);
    expect(region.cells[0]?.[0]).toEqual({
      floor: 'outside',
      wall: false,
      walkable: true,
    });
    expect(region.cells[1]?.[0]).toEqual({
      floor: 'outside',
      wall: false,
      walkable: true,
    });
  });

  it('walls the door frame beside the office door', () => {
    const world = createInitialWorld();
    const region = renderRegion(world, 1, CORRIDOR_Y + 1, 1, CORRIDOR_Y + 1);
    expect(region.cells[0]?.[0]).toEqual({
      floor: 'corridor',
      wall: true,
      walkable: false,
    });
  });

  it('walls the corridor edge rows above an empty column', () => {
    // corridorColumns 3, but only column 0 has rooms: column 1's edge rows
    // have no room to claim them, so they fall to the corridor-edge rule.
    const world = { ...createInitialWorld(), corridorColumns: 3 };
    const region = renderRegion(world, 11, CORRIDOR_Y - 1, 11, CORRIDOR_Y + 2);
    expect(region.cells[0]?.[0]).toEqual({
      floor: 'corridor',
      wall: true,
      walkable: false,
    });
    expect(region.cells[3]?.[0]).toEqual({
      floor: 'corridor',
      wall: true,
      walkable: false,
    });
  });

  it('walls the east end of the corridor', () => {
    const world = createInitialWorld();
    const bounds = mapBounds(world);
    const eastWallX = bounds.x + bounds.width - 1;
    const region = renderRegion(
      world,
      eastWallX,
      CORRIDOR_Y,
      eastWallX,
      CORRIDOR_Y,
    );
    expect(region.cells[0]?.[0]).toEqual({
      floor: 'corridor',
      wall: true,
      walkable: false,
    });
  });

  it('makes a furniture tile unwalkable, except the office door', () => {
    const world = createInitialWorld();
    const sofa = world.furniture.find((item) => item.kind === 'sofa');
    if (sofa === undefined) {
      throw new Error('expected a sofa');
    }
    const sofaCell = renderRegion(
      world,
      sofa.tile.x,
      sofa.tile.y,
      sofa.tile.x,
      sofa.tile.y,
    ).cells[0]?.[0];
    expect(sofaCell?.walkable).toBe(false);

    const officeDoor = world.furniture.find(
      (item) => item.kind === 'officeDoor',
    );
    if (officeDoor === undefined) {
      throw new Error('expected the office door');
    }
    const doorCell = renderRegion(
      world,
      officeDoor.tile.x,
      officeDoor.tile.y,
      officeDoor.tile.x,
      officeDoor.tile.y,
    ).cells[0]?.[0];
    expect(doorCell?.walkable).toBe(true);
  });

  it('filters mobs to those inside the region: furniture first, then avatars, in world order', () => {
    let world = addRoom(createInitialWorld(), 'task', 'task:t1');
    world = claimDesk(world, 'task:t1', 'agent-avatar:1').world;
    const desk = world.furniture.find((item) => item.kind === 'desk');
    if (desk === undefined) {
      throw new Error('expected a desk');
    }

    const region = renderRegion(
      world,
      desk.tile.x,
      desk.tile.y,
      desk.tile.x,
      desk.tile.y,
    );
    expect(region.mobs).toEqual([{ kind: 'furniture', furniture: desk }]);

    const wholeMap = renderRegion(world, 0, 0, 200, 20);
    const furnitureCount = world.furniture.length;
    expect(wholeMap.mobs.slice(0, furnitureCount)).toEqual(
      world.furniture.map((furniture) => ({ kind: 'furniture', furniture })),
    );
  });
});
