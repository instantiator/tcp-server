import { Scene, Scenes } from 'phaser';
import type { AgentDTO, RoleDTO, TaskDTO } from '../../../api/dtos';
import type { PatchOf } from '../../../util/diffs';
import { emitTcpEvent, offTcpEvent, onTcpEvent } from './TcpPhaserEventBus';

/** A Phaser scene representing agents, roles, and tasks within a company. */
export class TcpCompanyScene extends Scene {
  tcpRoles: { role: RoleDTO; object: Phaser.GameObjects.GameObject }[] = [];
  tcpAgents: { agent: AgentDTO; object: Phaser.GameObjects.GameObject }[] = [];
  tcpTasks: { task: TaskDTO; object: Phaser.GameObjects.GameObject }[] = [];

  constructor() {
    super({ key: 'TcpCompanyScene' });
  }

  create() {
    this.events.once(Scenes.Events.DESTROY, () => this.shutdown());

    onTcpEvent({
      event: 'create-agents',
      fn: (agents: AgentDTO[]) => {
        agents.forEach((agent) => this.createAgent(agent));
      },
    });

    onTcpEvent({
      event: 'update-agents',
      fn: (patches: PatchOf<AgentDTO>[]) => {
        patches.forEach((patch) => this.updateAgent(patch));
      },
    });

    onTcpEvent({
      event: 'remove-agents',
      fn: (agents: AgentDTO[]) => {
        agents.forEach((agent) => this.removeAgent(agent));
      },
    });

    emitTcpEvent({ event: 'scene-ready', value: undefined });
  }

  private createAgent(agent: AgentDTO) {
    // TODO(000.01): set game object properties based on agent properties
    const agentSprite = this.add.rectangle(
      Math.random() * 800,
      Math.random() * 600,
      40,
      40,
      0x00ff00,
    );
    agentSprite.setInteractive();
    agentSprite.on('pointerdown', () => {
      emitTcpEvent({
        event: 'agent-click',
        value: agent.id,
      });
    });
    this.tcpAgents.push({ agent, object: agentSprite });
  }

  private updateAgent(patch: PatchOf<AgentDTO>) {
    // TODO(000.01): update the game agent properies based on patch properties
    const existingAgent = this.tcpAgents.find((a) => a.agent.id === patch.id);
    if (existingAgent) {
      existingAgent.agent = { ...existingAgent.agent, ...patch };
    }
  }

  private removeAgent(agent: AgentDTO) {
    const index = this.tcpAgents.findIndex((a) => a.agent.id === agent.id);
    if (index !== -1) {
      this.tcpAgents[index].object.destroy();
      this.tcpAgents.splice(index, 1);
    }
  }

  shutdown() {
    offTcpEvent({ event: 'create-agents' });
    offTcpEvent({ event: 'update-agents' });
    offTcpEvent({ event: 'remove-agents' });
  }
}
