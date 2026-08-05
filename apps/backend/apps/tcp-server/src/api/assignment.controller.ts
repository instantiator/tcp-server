import { TcpAssignment } from '@tcp/shared';
import type { TcpAssignmentMode, TcpAssignmentStatus } from '@tcp/shared';
import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import type { UUID } from 'crypto';
import { FindOptionsWhere, IsNull, Repository } from 'typeorm';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CompanyMembershipGuard } from '../auth/company-membership.guard';
import {
  CompanyScope,
  CompanyScopeRequired,
} from '../auth/company-scope.decorator';

/** REST controller for observability listing of {@link TcpAssignment} records. */
@ApiTags('assignments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CompanyMembershipGuard)
@Controller({ path: 'api/assignment' })
export class AssignmentController {
  constructor(
    @InjectRepository(TcpAssignment)
    private readonly assignmentRepo: Repository<TcpAssignment>,
  ) {}

  /**
   * Lists assignments filtered by company and/or task (at least one
   * required), and optionally by role, status and/or mode. `taskId=null` (the
   * literal string) filters to orphan assignments (`taskId IS NULL`) —
   * plain conversations and consultations.
   */
  @ApiOperation({ summary: 'List assignments' })
  @ApiQuery({ name: 'companyId', required: false, description: 'Company UUID' })
  @ApiQuery({
    name: 'taskId',
    required: false,
    description:
      'Task UUID, or the literal string "null" to list orphan assignments',
  })
  @ApiQuery({ name: 'roleId', required: false, description: 'Role UUID' })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['ready', 'in-progress', 'in-qa', 'succeeded', 'failed', 'cancelled'],
  })
  @ApiQuery({
    name: 'mode',
    required: false,
    enum: ['plan', 'implement', 'qa', 'chat', 'consultee', 'finalise'],
    description:
      '`?taskId=null&mode=consultee` is the consultations list (ADR-023)',
  })
  @CompanyScope(
    { from: 'query', key: 'companyId', via: 'company' },
    // `taskId=null` is the orphan-assignment sentinel, not an id: skipping it
    // means such a query must still name its company.
    { from: 'query', key: 'taskId', via: 'task', ignore: ['null'] },
  )
  @CompanyScopeRequired('Provide at least one of companyId or taskId')
  @Get()
  async list(
    @Query('companyId') companyId?: UUID,
    @Query('taskId') taskId?: string,
    @Query('roleId') roleId?: UUID,
    @Query('status') status?: TcpAssignmentStatus,
    @Query('mode') mode?: TcpAssignmentMode,
  ): Promise<TcpAssignment[]> {
    if (!companyId && !taskId) {
      throw new BadRequestException(
        'Provide at least one of companyId or taskId',
      );
    }
    const where: FindOptionsWhere<TcpAssignment> = {
      ...(companyId ? { companyId } : {}),
      ...(roleId ? { roleId } : {}),
      ...(status ? { status } : {}),
      ...(mode ? { mode } : {}),
      ...(taskId === 'null'
        ? { taskId: IsNull() }
        : taskId
          ? { taskId: taskId as UUID }
          : {}),
    };
    return this.assignmentRepo.find({ where, order: { createdAt: 'DESC' } });
  }

  /** Retrieves a single assignment by UUID. */
  @ApiOperation({ summary: 'Get an assignment by ID' })
  @CompanyScope({ from: 'param', key: 'id', via: 'assignment' })
  @Get(':id')
  async get(@Param('id') id: UUID): Promise<TcpAssignment> {
    const assignment = await this.assignmentRepo.findOneBy({ id });
    if (!assignment) throw new NotFoundException(`Assignment ${id} not found`);
    return assignment;
  }
}
