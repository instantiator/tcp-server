import type { Repository } from 'typeorm';
import { AgentStatus, TcpAgent } from '../models/TcpAgent.model';

/**
 * Moves an agent whose start or resume job has been dispatched to
 * {@link AgentStatus.Queued}, unless something has already moved it on.
 *
 * Only an agent that is idle, or paused with its pause already claimed by
 * the resume (`pausedAt` cleared), qualifies. Anything else means the worker
 * got there first: it is running, finished, cancelled, or has paused again
 * (every pause sets `pausedAt`) — and overwriting that with `queued` would
 * leave the agent showing a wait that never ends. The check and the write
 * are one statement, so the worker can't slip in between them.
 *
 * @returns Whether the agent was moved, so the caller records the change
 *   only when there is one.
 */
export async function markQueued(
  repo: Repository<TcpAgent>,
  agentId: string,
): Promise<boolean> {
  const result = await repo
    .createQueryBuilder()
    .update(TcpAgent)
    .set({ status: AgentStatus.Queued })
    .where('id = :agentId', { agentId })
    .andWhere('status IN (:...from)', {
      from: [AgentStatus.Idle, AgentStatus.Paused],
    })
    .andWhere('pausedAt IS NULL')
    .execute();
  return (result.affected ?? 0) > 0;
}
