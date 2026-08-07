import type { CompanyStats, TcpTaskStatus } from '@tcp/shared';
import { ApiProperty } from '@nestjs/swagger';
import type { UUID } from 'crypto';
import { CreateCompanyDto } from './company.dto';

/** The statistic set carried with each `GET /api/company` row (ADR-023). */
export class CompanyStatsDto implements CompanyStats {
  @ApiProperty({ description: 'Agents that are idle, running or paused' })
  activeAgents!: number;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'integer' },
    description: 'Task count per TcpTaskStatus, zero-filled',
  })
  tasksByStatus!: Record<TcpTaskStatus, number>;

  @ApiProperty({ description: 'Conversations awaiting a user reply' })
  openEnquiries!: number;
}

// ponytail: a documentation shape only — the handler returns the entity plus
// stats. Reusing CreateCompanyDto keeps one description of the company fields;
// if the two drift, 005.01's generated client is the thing that notices.

/** One row of the `GET /api/company` response: the company plus its stats. */
export class CompanyListItemDto extends CreateCompanyDto {
  @ApiProperty({ format: 'uuid' })
  id!: UUID;

  @ApiProperty({ type: CompanyStatsDto })
  stats!: CompanyStatsDto;
}
