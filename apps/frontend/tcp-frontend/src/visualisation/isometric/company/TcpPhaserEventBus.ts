// EventBus.js
import { Events } from 'phaser';

import type { OfficeWorld, Tile } from './world/types';

export const TcpPhaserEventBus = new Events.EventEmitter();

/**
 * What a hover or a click landed on. `archive` carries no `id` — there is
 * only ever one archive room, unlike a role, an agent or a task.
 */
export type SelectionTarget =
  | { readonly kind: 'role' | 'agent' | 'task'; readonly id: string }
  | { readonly kind: 'archive' };

/**
 * What a hover landed on. Roles, agents and tasks can also be selected;
 * furniture and rooms (by their doorway) only explain themselves in a
 * tooltip. `id` is the furniture or room id from the office world.
 */
export type HoverTarget =
  | SelectionTarget
  | { readonly kind: 'furniture'; readonly id: string }
  | { readonly kind: 'room'; readonly id: string };

/** A hover over something in the office. `x`/`y` are canvas-relative pixels. */
export interface HoverEvent {
  readonly target: HoverTarget;
  readonly x: number;
  readonly y: number;
}

/**
 * A text label the scene draws above something in the office. React works
 * out the text, so the scene never needs names or strings. An avatar anchor
 * follows the avatar as it walks; a tile anchor stays put.
 */
export interface OfficeLabel {
  /** Stable across updates, so the scene can change a label's text in place. */
  readonly id: string;
  readonly text: string;
  readonly anchor:
    | { readonly kind: 'avatar'; readonly avatarId: string }
    | { readonly kind: 'tile'; readonly tile: Tile };
}

/**
 * The one source of truth: every event {@link TcpPhaserEventBus} carries,
 * mapped to its payload type. {@link TcpPhaserEmission}, {@link TcpPhaserOn}
 * and {@link TcpPhaserOff} are all generated from this by indexing a mapped
 * type over its own keys — the standard way to turn one map into several
 * matching discriminated unions, so a new event is one line here rather than
 * one case in each of three unions.
 *
 * React → scene: `world-changed`, `camera-pan`, `camera-follow`,
 * `motion-preference`, `labels-changed`, `thinking-changed`. Scene → React:
 * `scene-ready`, `avatar-arrived`, `avatar-exited`, `hover`, `select`,
 * `follow-stopped`, `listen-in`. Listeners on the
 * React side live only in `TcpPhaserVisualisation`; `CompanyVisualisation`
 * may emit but never listens directly.
 */
export interface TcpPhaserEventMap {
  'scene-ready': void;

  'world-changed': OfficeWorld;
  /** Screen pixels, not tiles: how far to scroll the camera. */
  'camera-pan': { readonly dx: number; readonly dy: number };
  'camera-follow': SelectionTarget | null;
  'motion-preference': { readonly reduced: boolean };
  /** Every label to show now. An empty list clears them all. */
  'labels-changed': readonly OfficeLabel[];
  /** The agents that are working now, each shown with a thought bubble (005.01). */
  'thinking-changed': readonly string[];

  'avatar-arrived': { readonly avatarId: string; readonly tile: Tile };
  'avatar-exited': { readonly avatarId: string };
  hover: HoverEvent | null;
  select: SelectionTarget;
  'follow-stopped': void;
  /** A thought bubble was clicked: open that agent's chat read-only. */
  'listen-in': { readonly agentId: string };
}

export type TcpPhaserEmission = {
  [K in keyof TcpPhaserEventMap]: {
    event: K;
    value: TcpPhaserEventMap[K];
    context?: unknown;
  };
}[keyof TcpPhaserEventMap];

export type TcpPhaserOn = {
  [K in keyof TcpPhaserEventMap]: {
    event: K;
    fn: (value: TcpPhaserEventMap[K]) => void;
    context?: unknown;
  };
}[keyof TcpPhaserEventMap];

export type TcpPhaserOff = {
  [K in keyof TcpPhaserEventMap]: {
    event: K;
    /**
     * The exact function passed to {@link onTcpEvent}. The bus is a module
     * singleton: under React StrictMode two games can briefly exist, and
     * Phaser destroys a game on the next frame rather than at once. An
     * omitted `fn` removes every listener for the event — including one a
     * different mounted game just registered — so every caller must pass it.
     */
    fn: (value: TcpPhaserEventMap[K]) => void;
    context?: unknown;
    once?: boolean;
  };
}[keyof TcpPhaserEventMap];

export function emitTcpEvent(data: TcpPhaserEmission): void {
  TcpPhaserEventBus.emit(data.event, data.value, data.context);
}

export function onTcpEvent(data: TcpPhaserOn): void {
  TcpPhaserEventBus.on(data.event, data.fn, data.context);
}

export function offTcpEvent(data: TcpPhaserOff): void {
  TcpPhaserEventBus.off(data.event, data.fn, data.context, data.once);
}
