// EventBus.js
import { Events } from 'phaser';

import type { OfficeWorld, Tile } from './world/types';

export const TcpPhaserEventBus = new Events.EventEmitter();

/** What a hover or a click landed on. */
export interface SelectionTarget {
  readonly kind: 'role' | 'agent' | 'task';
  readonly id: string;
}

/** A hover over something selectable. `x`/`y` are canvas-relative pixels. */
export interface HoverEvent {
  readonly target: SelectionTarget;
  readonly x: number;
  readonly y: number;
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
 * `motion-preference`. Scene → React: `scene-ready`, `avatar-arrived`,
 * `avatar-exited`, `hover`, `select`, `follow-stopped`. Listeners on the
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

  'avatar-arrived': { readonly avatarId: string; readonly tile: Tile };
  'avatar-exited': { readonly avatarId: string };
  hover: HoverEvent | null;
  select: SelectionTarget;
  'follow-stopped': void;
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
