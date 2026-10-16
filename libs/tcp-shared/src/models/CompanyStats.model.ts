import type { TcpTaskStatus } from './TcpTask.model';
import type { TcpCompany } from './TcpCompany.model';
import type { MemberType } from './CompanyUser.model';

/**
 * The fixed per-company statistic set returned with `GET /api/company`
 * (ADR-023). Fixed rather than open-ended so it stays one query per stat
 * for the whole list, not one request per company.
 */
export interface CompanyStats {
  /** Agents in a non-terminal state: idle, running or paused. */
  activeAgents: number;
  /** Task count per status; every status key is present, zero-filled. */
  tasksByStatus: Record<TcpTaskStatus, number>;
  /** Conversations awaiting a user reply. */
  openEnquiries: number;
}

/**
 * A company as `GET /api/company` returns it — the record plus its stats and
 * the caller's own member type (`null` when an administrator's `?all` list
 * includes a company they don't belong to).
 */
export type CompanyListItem = TcpCompany & {
  stats: CompanyStats;
  memberType: MemberType | null;
};

/** A zero-filled {@link CompanyStats}, for a company with nothing running. */
export function emptyCompanyStats(): CompanyStats {
  return {
    activeAgents: 0,
    tasksByStatus: {
      ready: 0,
      planning: 0,
      'in-progress': 0,
      finalising: 0,
      succeeded: 0,
      failed: 0,
      cancelled: 0,
    },
    openEnquiries: 0,
  };
}
