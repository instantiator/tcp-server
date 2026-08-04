import {
  CompanyStats,
  Conversation,
  emptyCompanyStats,
  TcpAgent,
  TcpTask,
  TcpTaskStatus,
} from '@tcp/shared';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { UUID } from 'crypto';
import { Repository } from 'typeorm';
import { ACTIVE_AGENT_STATUSES } from '../db/agent-db.service';

/** One `GROUP BY companyId` row, as the driver returns it. */
interface CountRow {
  companyId: UUID;
  count: string | number;
}

/** A `GROUP BY companyId, status` row for the task breakdown. */
interface StatusCountRow extends CountRow {
  status: TcpTaskStatus;
}

/** Builds the per-company statistics carried by `GET /api/company` (ADR-023). */
@Injectable()
export class CompanyStatsService {
  constructor(
    @InjectRepository(TcpAgent)
    private readonly agentRepo: Repository<TcpAgent>,
    @InjectRepository(TcpTask)
    private readonly taskRepo: Repository<TcpTask>,
    @InjectRepository(Conversation)
    private readonly convRepo: Repository<Conversation>,
  ) {}

  /**
   * Builds the {@link CompanyStats} for a set of companies in a fixed number
   * of queries — three grouped aggregates, whatever the company count. Never
   * one query per company: the overview lists every company a user belongs to.
   *
   * Every id in `companyIds` gets an entry, zero-filled where nothing matched.
   */
  async listStats(companyIds: UUID[]): Promise<Map<UUID, CompanyStats>> {
    const stats = new Map<UUID, CompanyStats>();
    if (companyIds.length === 0) return stats;
    for (const id of companyIds) stats.set(id, emptyCompanyStats());

    const [agents, tasks, enquiries] = await Promise.all([
      this.agentRepo
        .createQueryBuilder('agent')
        .select('agent.companyId', 'companyId')
        .addSelect('COUNT(*)', 'count')
        .where('agent.companyId IN (:...companyIds)', { companyIds })
        .andWhere('agent.status IN (:...statuses)', {
          statuses: [...ACTIVE_AGENT_STATUSES],
        })
        .groupBy('agent.companyId')
        .getRawMany<CountRow>(),
      this.taskRepo
        .createQueryBuilder('task')
        .select('task.companyId', 'companyId')
        .addSelect('task.status', 'status')
        .addSelect('COUNT(*)', 'count')
        .where('task.companyId IN (:...companyIds)', { companyIds })
        .groupBy('task.companyId')
        .addGroupBy('task.status')
        .getRawMany<StatusCountRow>(),
      this.convRepo
        .createQueryBuilder('conversation')
        .select('conversation.companyId', 'companyId')
        .addSelect('COUNT(*)', 'count')
        .where('conversation.companyId IN (:...companyIds)', { companyIds })
        .andWhere('conversation.status = :status', { status: 'awaiting_user' })
        .groupBy('conversation.companyId')
        .getRawMany<CountRow>(),
    ]);

    // Every count is coerced with Number(): Postgres returns aggregates as
    // strings, SQLite as numbers, and both tiers run these queries.
    for (const row of agents) {
      const entry = stats.get(row.companyId);
      if (entry) entry.activeAgents = Number(row.count);
    }
    for (const row of tasks) {
      const entry = stats.get(row.companyId);
      if (entry) entry.tasksByStatus[row.status] = Number(row.count);
    }
    for (const row of enquiries) {
      const entry = stats.get(row.companyId);
      if (entry) entry.openEnquiries = Number(row.count);
    }

    return stats;
  }
}
