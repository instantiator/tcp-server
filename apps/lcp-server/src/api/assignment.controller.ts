import { LcpAssignment } from '@lcp/shared';
import type { LcpAssignmentStatus } from '@lcp/shared';
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

/** REST controller for observability listing of {@link LcpAssignment} records. */
@ApiTags('assignments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller({ path: 'api/assignment' })
export class AssignmentController {
  constructor(
    @InjectRepository(LcpAssignment)
    private readonly assignmentRepo: Repository<LcpAssignment>,
  ) {}

  /**
   * Lists assignments filtered by company and/or task (at least one
   * required), and optionally by role and/or status. `taskId=null` (the
   * literal string) filters to orphan assignments (`taskId IS NULL`) —
   * plain conversations and consultations.
   */
  @ApiOperation({ summary: 'List assignments' })
  @ApiQuery({
    name: 'taskId',
    required: false,
    description:
      'Task UUID, or the literal string "null" to list orphan assignments',
  })
  @Get()
  async list(
    @Query('companyId') companyId?: UUID,
    @Query('taskId') taskId?: string,
    @Query('roleId') roleId?: UUID,
    @Query('status') status?: LcpAssignmentStatus,
  ): Promise<LcpAssignment[]> {
    if (!companyId && !taskId) {
      throw new BadRequestException(
        'Provide at least one of companyId or taskId',
      );
    }
    const where: FindOptionsWhere<LcpAssignment> = {
      ...(companyId ? { companyId } : {}),
      ...(roleId ? { roleId } : {}),
      ...(status ? { status } : {}),
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
  @Get(':id')
  async get(@Param('id') id: UUID): Promise<LcpAssignment> {
    const assignment = await this.assignmentRepo.findOneBy({ id });
    if (!assignment) throw new NotFoundException(`Assignment ${id} not found`);
    return assignment;
  }
}
