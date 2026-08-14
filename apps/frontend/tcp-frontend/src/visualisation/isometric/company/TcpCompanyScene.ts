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
    console.log('Creating agent in Phaser scene:', agent);
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
    // TODO: review the agent, set agent properties
  }

  private updateAgent(patch: PatchOf<AgentDTO>) {
    const existingAgent = this.tcpAgents.find((a) => a.agent.id === patch.id);
    if (existingAgent) {
      console.log('Updating agent in Phaser scene:', patch);
      existingAgent.agent = { ...existingAgent.agent, ...patch };
    }
    // TODO: review the patch, update the agent by properties
  }

  private removeAgent(agent: AgentDTO) {
    const index = this.tcpAgents.findIndex((a) => a.agent.id === agent.id);
    if (index !== -1) {
      console.log('Removing agent from Phaser scene:', agent);
      this.tcpAgents[index].object.destroy();
      this.tcpAgents.splice(index, 1);
    }
  }

  // 4. REACT -> PHASER: Listen for state changes (e.g., pathfinding targets)
  // TcpPhaserEventBus.on(
  //   'move-npc-command',
  //   (targetCoords: { x: number; y: number }) => {
  //     // In a real app, you'd trigger your pathfinding here.
  //     this.tweens.add({
  //       targets: this.tcpAgents[0],
  //       x: targetCoords.x,
  //       y: targetCoords.y,
  //       duration: 1000,
  //     });
  //   },
  // );

  shutdown() {
    offTcpEvent({ event: 'create-agents' });
    offTcpEvent({ event: 'update-agents' });
    offTcpEvent({ event: 'remove-agents' });
  }
}
