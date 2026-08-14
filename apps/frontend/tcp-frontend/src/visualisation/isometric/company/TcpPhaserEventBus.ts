// EventBus.js
import { Events } from 'phaser';

import type { AgentDTO, RoleDTO, TaskDTO } from '../../../api/dtos';
import type { PatchOf } from '../../../util/diffs';

export const TcpPhaserEventBus = new Events.EventEmitter();

/**
 * The one source of truth: every event {@link TcpPhaserEventBus} carries,
 * mapped to its payload type. {@link TcpPhaserEmission}, {@link TcpPhaserOn}
 * and {@link TcpPhaserOff} are all generated from this by indexing a mapped
 * type over its own keys — the standard way to turn one map into several
 * matching discriminated unions, so a new event is one line here rather than
 * one case in each of three unions.
 */
export interface TcpPhaserEventMap {
  'scene-ready': void;

  'create-roles': RoleDTO[];
  'update-roles': PatchOf<RoleDTO>[];
  'remove-roles': RoleDTO[];
  'role-click': string;

  'create-agents': AgentDTO[];
  'update-agents': PatchOf<AgentDTO>[];
  'remove-agents': AgentDTO[];
  'agent-click': string;

  'create-tasks': TaskDTO[];
  'update-tasks': PatchOf<TaskDTO>[];
  'remove-tasks': TaskDTO[];
  'task-click': string;
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
    fn?: (value: TcpPhaserEventMap[K]) => void;
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
