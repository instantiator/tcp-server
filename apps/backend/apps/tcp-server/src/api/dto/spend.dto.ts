import {
  CapLimitReport,
  CapReport,
  CompanySpend,
  ProviderUsage,
  SpendOverview,
  TaskUsage,
  UsageBucket,
  type CapAction,
  type CapDismissal,
  type ResumeResult,
} from '@tcp/shared';
import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

/** Body of `POST /api/spend/caps/:provider/dismiss`. */
export class DismissCapDto {
  /** `reset` lifts the cap until its window next ends; `indefinite` until it is restored. */
  @ApiProperty({ enum: ['reset', 'indefinite'] })
  @IsIn(['reset', 'indefinite'])
  until!: 'reset' | 'indefinite';
}

/** {@link ResumeResult}, published as a class so the Swagger plugin can read it. */
export class ResumeResultDto implements ResumeResult {
  /** Agents a resume was requested for. */
  resumed!: number;
}

/** {@link ProviderUsage}, published as a class so the Swagger plugin can read it. */
export class ProviderUsageDto implements ProviderUsage {
  provider!: string;
  inputTokens!: number;
  outputTokens!: number;
}

/** {@link TaskUsage}, published as a class so the Swagger plugin can read it. */
export class TaskUsageDto implements TaskUsage {
  taskId!: string;
  inputTokens!: number;
  outputTokens!: number;
}

/** {@link UsageBucket}, published as a class so the Swagger plugin can read it. */
export class UsageBucketDto implements UsageBucket {
  bucketStart!: string;
  inputTokens!: number;
  outputTokens!: number;
}

/** {@link CapLimitReport}, published as a class so the Swagger plugin can read it. */
export class CapLimitReportDto implements CapLimitReport {
  tokens!: number;
  per!: string;
  used!: number;
  percent!: number;
  @ApiProperty({ type: String, nullable: true })
  windowStart!: string | null;
  @ApiProperty({ type: String, nullable: true })
  resetsAt!: string | null;
}

/** {@link CapReport}, published as a class so the Swagger plugin can read it. */
export class CapReportDto implements CapReport {
  provider!: string;
  @ApiProperty({ enum: ['pause', 'finish-agents', 'finish-tasks'] })
  action!: CapAction;
  @ApiProperty({ enum: ['none', 'until-reset', 'indefinite'] })
  dismissal!: CapDismissal;
  holding!: boolean;
  @ApiProperty({ type: String, nullable: true })
  reachedUntil!: string | null;
  @ApiProperty({ type: () => [CapLimitReportDto] })
  limits!: CapLimitReportDto[];
}

/** {@link SpendOverview}, published as a class so the Swagger plugin can read it. */
export class SpendOverviewDto implements SpendOverview {
  @ApiProperty({ type: String, nullable: true })
  trackingSince!: string | null;
  @ApiProperty({ type: () => [ProviderUsageDto] })
  providers!: ProviderUsageDto[];
  @ApiProperty({ type: () => [CapReportDto] })
  caps!: CapReportDto[];
}

/** {@link CompanySpend}, published as a class so the Swagger plugin can read it. */
export class CompanySpendDto implements CompanySpend {
  @ApiProperty({ type: String, nullable: true })
  trackingSince!: string | null;
  @ApiProperty({ type: () => [ProviderUsageDto] })
  providers!: ProviderUsageDto[];
  @ApiProperty({ type: () => [TaskUsageDto] })
  tasks!: TaskUsageDto[];
  @ApiProperty({ type: () => [UsageBucketDto] })
  series!: UsageBucketDto[];
}
