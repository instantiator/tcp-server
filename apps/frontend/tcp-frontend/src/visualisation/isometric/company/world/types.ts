/**
 * The office model behind the company visualisation.
 *
 * Pure data. Nothing under `world/`, `rules/` or `motion/` imports React or
 * Phaser: React works the office out from live company data (`rules/`), and
 * the Phaser scene draws it and walks avatars through it (`scene/`).
 *
 * Positions are grid tiles. `x` runs along the corridor, away from the office
 * door. `y` runs from the north rooms, across the corridor, to the south rooms.
 */

/** One grid position. */
export interface Tile {
  readonly x: number;
  readonly y: number;
}

/** A rectangle of tiles. `x` and `y` are its top-left tile. */
export interface Bounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** What a room is for. It decides the room's furniture and its floor style. */
export type RoomPurpose = 'rec' | 'mail' | 'corridor' | 'task' | 'oneToOne';

/** A room. Every room except the corridor sits in a slot along the corridor. */
export interface Room {
  /** `rec`, `mail`, `corridor`, `task:<taskId>` or `oneToOne:<consulteeAssignmentId>`. */
  readonly id: string;
  readonly purpose: RoomPurpose;
  /** The slot along the corridor, or `null` for the corridor itself. */
  readonly slot: number | null;
  /** The room's area, walls included. */
  readonly bounds: Bounds;
  /** The gap in the wall onto the corridor, or `null` for the corridor. */
  readonly door: Tile | null;
  /** Task rooms only: the task the room is for. */
  readonly taskId?: string;
  /**
   * The room's reason to exist has gone: its task finished, or its
   * consultation ended. It stays until nobody belongs to it, then the cleanup
   * rule removes it and frees its slot.
   */
  readonly closing: boolean;
}

/** The kinds of furniture. Each is drawn as its own placeholder shape. */
export type FurnitureKind =
  'desk' | 'whiteboard' | 'sofa' | 'pigeonholes' | 'table' | 'officeDoor';

/** One piece of furniture, standing on one tile. */
export interface Furniture {
  /** `<roomId>:<kind>`, or `<roomId>:desk:<n>` and `<roomId>:sofa:<n>` for the repeated kinds. */
  readonly id: string;
  readonly kind: FurnitureKind;
  readonly roomId: string;
  readonly tile: Tile;
  /** Desks only: the avatar the desk belongs to. A desk belongs to one avatar at most. */
  readonly ownerAvatarId?: string;
}

/**
 * Where an avatar is heading. The scene turns it into a tile when it plans
 * a route, because the right tile depends on who is standing where.
 */
export type AvatarTarget =
  /** A free tile beside a piece of furniture: a desk, a whiteboard, the pigeonholes. */
  | { readonly kind: 'furniture'; readonly furnitureId: string }
  /** A free tile beside another avatar, wherever it is standing now. */
  | { readonly kind: 'avatar'; readonly avatarId: string }
  /** Exactly this tile. Role avatars use it for their spot in the rec room. */
  | { readonly kind: 'tile'; readonly tile: Tile }
  /** Outside the office door. Reaching it takes the avatar out of play. */
  | { readonly kind: 'exit' };

/**
 * A figure in the office. Role avatars stand still in the rec room. Agent
 * avatars walk. An agent avatar can outlive its agent: when the agent
 * finishes, the avatar goes back to its desk and waits for the next agent of
 * the same role in the same task.
 */
export interface Avatar {
  /** `role:<roleId>` or `agent-avatar:<n>`. Never an agent id, because avatars outlive agents. */
  readonly id: string;
  readonly kind: 'role' | 'agent';
  readonly roleId: string;
  /** The agent this avatar shows, or `null` once that agent has finished. */
  readonly agentId: string | null;
  /**
   * The assignment this avatar is working, or the last one it worked once
   * its agent has finished. A QA reviewer finds the avatar it reviews by this.
   */
  readonly assignmentId: string | null;
  /** The task whose room this avatar belongs to, or `null` for role, consultee and chat avatars. */
  readonly taskId: string | null;
  /** The avatar's desk, or `null` when it has none. */
  readonly deskId: string | null;
  /** Where the avatar was created, then the tile it last arrived at. The scene owns the live position. */
  readonly location: Tile;
  readonly target: AvatarTarget;
  /**
   * Put the avatar straight at its target instead of walking it there. True
   * for role avatars and for avatars created from the first snapshot, so a
   * page load doesn't show everyone walking in from the door.
   */
  readonly placeAtTarget: boolean;
  /**
   * The avatar carries its role. A new agent avatar walks to its role in
   * the rec room to collect it before heading anywhere else. Role avatars,
   * and avatars placed from the first snapshot, start with it.
   */
  readonly hasRole: boolean;
}

/** The whole office. The reducer produces a new one, and the scene draws it. */
export interface OfficeWorld {
  readonly rooms: readonly Room[];
  readonly furniture: readonly Furniture[];
  readonly avatars: readonly Avatar[];
  /**
   * Goes up by one whenever a room or a piece of furniture is added or
   * removed. The scene redraws walls, floors and furniture only when it changes.
   */
  readonly layoutVersion: number;
  /** The number the next `agent-avatar:<n>` id will use. */
  readonly nextAvatarNumber: number;
  /** How many slot columns the corridor runs past. It grows and never shrinks during a session. */
  readonly corridorColumns: number;
}

/** One tile of a rendered region: its static parts only. */
export interface Cell {
  /** The floor style, `'outside'` beyond the office door, or `null` where nothing is. */
  readonly floor: RoomPurpose | 'outside' | null;
  readonly wall: boolean;
  /** Has a floor, isn't a wall, and holds no furniture except the office door. */
  readonly walkable: boolean;
}

/** Something drawn on top of the cells, at its own tile. */
export type Mob =
  | { readonly kind: 'furniture'; readonly furniture: Furniture }
  | { readonly kind: 'avatar'; readonly avatar: Avatar };

/** A rectangular part of the office, ready to draw. */
export interface Region {
  /** The region's top-left tile. `cells[0][0]` is this tile. */
  readonly origin: Tile;
  /** `cells[row][column]`, where a row is one `y` and a column is one `x`. */
  readonly cells: readonly (readonly Cell[])[];
  /** The furniture and avatars inside the region. An avatar is placed by its `location`. */
  readonly mobs: readonly Mob[];
}
