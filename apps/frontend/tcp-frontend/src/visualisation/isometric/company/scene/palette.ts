/*
 * Placeholder office colours: calm, low-saturation tones with enough
 * contrast between adjacent floor styles to read as separate rooms.
 */
// ponytail: fixed palette; the canvas does not follow the high-contrast theme (unresolved note)

import type { FurnitureKind, RoomPurpose } from '../world/types';

/** A floor's tint, per room purpose, plus the apron outside the office door. */
export const FLOOR_COLOURS: Record<RoomPurpose | 'outside', number> = {
  rec: 0xd8e6d0,
  mail: 0xe6ddc8,
  corridor: 0xcfd3d6,
  task: 0xd6e2ea,
  oneToOne: 0xe6d8e0,
  outside: 0xb9c2b0,
};

/** A wall's three visible faces, per the room purpose its floor belongs to. */
export const WALL_COLOURS: Record<
  RoomPurpose,
  { readonly top: number; readonly left: number; readonly right: number }
> = {
  rec: { top: 0xb7c9ac, left: 0x8fa384, right: 0xa2b797 },
  mail: { top: 0xc9bd9f, left: 0x9c9276, right: 0xb2a688 },
  corridor: { top: 0xaeb4b8, left: 0x868c8f, right: 0x9aa0a3 },
  task: { top: 0xacc0cc, left: 0x8496a1, right: 0x99adb8 },
  oneToOne: { top: 0xc9b6c1, left: 0x9c8b95, right: 0xb2a0ab },
};

/** A placeholder shape's fill colour, per furniture kind. */
export const FURNITURE_COLOURS: Record<FurnitureKind, number> = {
  desk: 0x9c7a54,
  whiteboard: 0xf5f5f0,
  sofa: 0x7f8fa6,
  pigeonholes: 0xa68a5f,
  table: 0x8a6f4e,
  officeDoor: 0x5c5148,
};

/** The pale block of pages on top of a role's book. */
export const BOOK_PAGES_COLOUR = 0xf4f1e8;

/** The floor grid's line colour. Drawn faint, at a low alpha, by the caller. */
export const GRID_LINE_COLOUR = 0x1a2a1f;

/** Eight distinct, calm colours, one per role. */
export const ROLE_COLOURS: readonly number[] = [
  0xc1694f, // terracotta
  0x3d8f8f, // teal
  0x8e7cc3, // lavender
  0xbf8b2e, // ochre
  0x5b8c5a, // moss
  0xb15c7c, // rose
  0x4f6d9a, // slate blue
  0xa07a52, // tan
];

/**
 * A stable colour for a role: a plain string hash mod the palette length, so
 * the same role always draws the same colour without needing to remember an
 * assignment anywhere.
 */
export function roleColour(roleId: string): number {
  let hash = 0;
  for (let i = 0; i < roleId.length; i += 1) {
    hash = (hash * 31 + roleId.charCodeAt(i)) | 0;
  }
  return ROLE_COLOURS[Math.abs(hash) % ROLE_COLOURS.length];
}

function clampChannel(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function shiftChannel(
  base: number,
  amount: number,
  byteOffset: number,
): number {
  const channel = (base >> byteOffset) & 0xff;
  return clampChannel(channel + amount);
}

/** `base` shifted towards white (`amount` > 0) or black (`amount` < 0), channel by channel. */
function shift(base: number, amount: number): number {
  const r = shiftChannel(base, amount, 16);
  const g = shiftChannel(base, amount, 8);
  const b = shiftChannel(base, amount, 0);
  return (r << 16) | (g << 8) | b;
}

/**
 * An IsoBox's three face colours, derived from one base colour so a figure
 * needs only its role's colour, not three. The top face is lightest, as if
 * lit from above; the left face is darkest.
 */
export function shadesOf(base: number): {
  readonly top: number;
  readonly left: number;
  readonly right: number;
} {
  return {
    top: shift(base, 30),
    left: shift(base, -40),
    right: shift(base, -15),
  };
}
