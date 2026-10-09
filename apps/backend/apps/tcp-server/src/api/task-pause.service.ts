import {
  AgentStatus,
  AuditEventType,
  buildAgentChangeSummary,
  TcpAgent,
  TcpTask,
} from '@tcp/shared';
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { UUID } from 'crypto';
import { In, IsNull, Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { TaskStateService } from './task-state.service';

/** Task statuses a user can pause: the ones with agents at work. */
const PAUSABLE: TcpTask['status'][] = ['planning', 'in-progress', 'finalising'];

/** Agent statuses a pause stops: started, or about to start. */
const STOPPABLE = [AgentStatus.Idle, AgentStatus.Queued, AgentStatus.Running];

/**
 * Pauses a task at a user's request.
 *
 * A soft stop: the task records the pause, and each of its working agents is
 * marked paused, so a running loop stops at its next status check — after
 * its current LLM call and tools — and a queued job is dropped. Nothing
 * in-flight is killed. Resuming is {@link SpendResumeService.resumeTask}.
 */
@Injectable()
export class TaskPauseService {
  constructor(
    @InjectRepository(TcpTask)
    private readonly taskRepo: Repository<TcpTask>,
    @InjectRepository(TcpAgent)
    private readonly agentRepo: Repository<TcpAgent>,
    private readonly audit: AuditService,
    private readonly taskState: TaskStateService,
  ) {}

  /**
   * Pauses the task and its working agents.
   *
   * @param pausedBy - How to name the user to others ("Paused by …").
   * @throws {@link NotFoundException} for an unknown task.
   * @throws {@link ConflictException} when the task isn't running or is
   *   already paused.
   */
  async pause(taskId: UUID, pausedBy: string): Promise<TcpTask> {
    if (!(await this.taskRepo.existsBy({ id: taskId }))) {
      throw new NotFoundException(`Task ${taskId} not found`);
    }
    const pausedAt = new Date();
    // One conditional write, so two pauses can't both claim it.
    const claim = await this.taskRepo.update(
      { id: taskId, status: In(PAUSABLE), pausedAt: IsNull() },
      { pausedAt, pausedBy },
    );
    if ((claim.affected ?? 0) === 0) {
      throw new ConflictException(
        "This task isn't running, so it can't be paused.",
      );
    }

    const agents = await this.agentRepo.find({
      where: { status: In(STOPPABLE), assignment: { taskId } },
      relations: { role: true },
    });
    for (const agent of agents) {
      await this.pauseAgent(agent, pausedAt);
    }

    const task = await this.taskRepo.findOneByOrFail({ id: taskId });
    await this.taskState.recordTaskState(task, task.status, 'paused by a user');
    return task;
  }

  /**
   * Marks one agent paused, unless it has moved on since it was read — it
   * finished, or paused for its own reason, which then stands.
   */
  private async pauseAgent(agent: TcpAgent, pausedAt: Date): Promise<void> {
    const result = await this.agentRepo.update(
      { id: agent.id, status: In(STOPPABLE) },
      { status: AgentStatus.Paused, pauseReason: 'manual', pausedAt },
    );
    if ((result.affected ?? 0) === 0) return;
    await this.audit.record(
      agent.companyId,
      agent.role.name,
      agent.id,
      AuditEventType.StateChange,
      {
        entity: 'agent',
        newStatus: AgentStatus.Paused,
        reason: 'manual',
        summary: buildAgentChangeSummary({
          ...agent,
          status: AgentStatus.Paused,
        }),
      },
    );
  }
}
