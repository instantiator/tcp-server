import { AUTO, Game } from 'phaser';
import { useEffect, useLayoutEffect, useRef } from 'react';
import type { AgentDTO, RoleDTO, TaskDTO } from '../../../api/dtos';
import { diffList } from '../../../util/diffs';
import { TcpCompanyScene } from './TcpCompanyScene';
import { emitTcpEvent, offTcpEvent, onTcpEvent } from './TcpPhaserEventBus';

export interface TcpPhaserVisualisationProps {
  readonly companyId: string;
  readonly roles: RoleDTO[];
  readonly agents: AgentDTO[];
  readonly tasks: TaskDTO[];
  readonly onRoleClick?: (roleId: string) => void;
  readonly onAgentClick?: (agentId: string) => void;
  readonly onTaskClick?: (taskId: string) => void;
}

export default function TcpPhaserVisualisation({
  roles,
  agents,
  tasks,
  onRoleClick,
  onAgentClick,
  onTaskClick,
}: TcpPhaserVisualisationProps) {
  const gameRef = useRef<Phaser.Game | null>(null);

  /** Current set of roles - for comparison when {@link roles} changes */
  const rolesRef = useRef<RoleDTO[]>([]);
  /** Current set of agents - for comparison when {@link agents} changes */
  const agentsRef = useRef<AgentDTO[]>([]);
  /** Current set of tasks - for comparison when {@link tasks} changes */
  const tasksRef = useRef<TaskDTO[]>([]);

  /** Always contains the latest values of {@link roles} */
  const rolesLatestRef = useRef<RoleDTO[]>(roles);
  /** Always contains the latest values of {@link agents} */
  const agentsLatestRef = useRef<AgentDTO[]>(agents);
  /** Always contains the latest values of {@link tasks} */
  const tasksLatestRef = useRef<TaskDTO[]>(tasks);

  // Immediately update the latest refs - used to handle the 'scene-ready' event.
  rolesLatestRef.current = roles;
  agentsLatestRef.current = agents;
  tasksLatestRef.current = tasks;

  /** Game mount and unmount */
  useLayoutEffect(() => {
    onTcpEvent({
      event: 'scene-ready',
      fn: () => {
        emitTcpEvent({ event: 'create-roles', value: rolesLatestRef.current });
        emitTcpEvent({
          event: 'create-agents',
          value: agentsLatestRef.current,
        });
        emitTcpEvent({ event: 'create-tasks', value: tasksLatestRef.current });
        rolesRef.current = rolesLatestRef.current;
        agentsRef.current = agentsLatestRef.current;
        tasksRef.current = tasksLatestRef.current;
      },
    });

    // Create the game if it doesn't exist
    gameRef.current =
      gameRef.current ??
      new Game({
        type: AUTO,
        width: 800,
        height: 600,
        parent: 'game-container', // Matches the div id below
        scene: [TcpCompanyScene],
      });

    // Unmount
    return () => {
      offTcpEvent({ event: 'scene-ready' });
      if (gameRef.current) {
        gameRef.current.destroy(true);
        gameRef.current = null;
      }
    };
  }, []);

  /** Pass changes to {@link roles} through the {@link TcpPhaserEventBus} */
  useEffect(() => {
    const diffs = diffList(rolesRef.current, roles);
    if (diffs.created.length > 0)
      emitTcpEvent({ event: 'create-roles', value: diffs.created });
    if (diffs.updated.length > 0)
      emitTcpEvent({ event: 'update-roles', value: diffs.updated });
    if (diffs.removed.length > 0)
      emitTcpEvent({ event: 'remove-roles', value: diffs.removed });
    rolesRef.current = roles;
  }, [roles]);

  /** Pass changes to {@link agents} through the {@link TcpPhaserEventBus} */
  useEffect(() => {
    const diffs = diffList(agentsRef.current, agents);
    if (diffs.created.length > 0)
      emitTcpEvent({ event: 'create-agents', value: diffs.created });
    if (diffs.updated.length > 0)
      emitTcpEvent({ event: 'update-agents', value: diffs.updated });
    if (diffs.removed.length > 0)
      emitTcpEvent({ event: 'remove-agents', value: diffs.removed });
    agentsRef.current = agents;
  }, [agents]);

  /** Pass changes to {@link tasks} through the {@link TcpPhaserEventBus} */
  useEffect(() => {
    const diffs = diffList(tasksRef.current, tasks);
    if (diffs.created.length > 0)
      emitTcpEvent({ event: 'create-tasks', value: diffs.created });
    if (diffs.updated.length > 0)
      emitTcpEvent({ event: 'update-tasks', value: diffs.updated });
    if (diffs.removed.length > 0)
      emitTcpEvent({ event: 'remove-tasks', value: diffs.removed });
    tasksRef.current = tasks;
  }, [tasks]);

  /** Register event listeners for in-game clicks */
  useEffect(() => {
    onTcpEvent({
      event: 'role-click',
      fn: (roleId: string) => {
        onRoleClick?.(roleId);
      },
    });

    onTcpEvent({
      event: 'agent-click',
      fn: (agentId: string) => {
        onAgentClick?.(agentId);
      },
    });

    onTcpEvent({
      event: 'task-click',
      fn: (taskId: string) => {
        onTaskClick?.(taskId);
      },
    });

    return () => {
      offTcpEvent({ event: 'role-click' });
      offTcpEvent({ event: 'agent-click' });
      offTcpEvent({ event: 'task-click' });
    };
  }, [onAgentClick, onRoleClick, onTaskClick]);

  return (
    <>
      <div id="game-container"></div>
    </>
  );
}
