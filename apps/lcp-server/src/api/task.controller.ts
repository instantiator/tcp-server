import type { LcpAssignment, LcpTask } from '@lcp/shared';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { UUID } from 'crypto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CreateTaskDto } from './dto/task.dto';
import { TaskMaterialSummary, TaskService } from './task.service';

/** Subset of the multer file object relevant to a materials upload. */
interface UploadedFileBuffer {
  originalname: string;
  buffer: Buffer;
  mimetype?: string;
}

/** REST controller for {@link LcpTask} create, materials upload, start, list, and get. */
@ApiTags('tasks')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller({ path: 'api/task' })
export class TaskController {
  constructor(private readonly tasks: TaskService) {}

  /** Creates a task in the `ready` state. No plan is generated until `POST /api/task/:id/start`. */
  @ApiOperation({ summary: 'Create a task' })
  @Post()
  async createTask(@Body() body: CreateTaskDto): Promise<LcpTask> {
    return this.tasks.create(body);
  }

  /**
   * Uploads a task material (field `file`). Rejected once the task has left
   * the `ready` state.
   */
  @ApiOperation({ summary: 'Upload a task material' })
  @ApiConsumes('multipart/form-data')
  @Post(':id/materials')
  @UseInterceptors(FileInterceptor('file'))
  async uploadMaterial(
    @Param('id') id: UUID,
    @UploadedFile() file: UploadedFileBuffer,
  ): Promise<TaskMaterialSummary> {
    return this.tasks.addMaterial(
      id,
      file.originalname,
      file.buffer,
      file.mimetype ?? 'application/octet-stream',
    );
  }

  /**
   * Starts a task: transitions `ready → planning` and dispatches the planner
   * agent (a logged no-op until `docs/prompts/010.2.7`).
   */
  @ApiOperation({ summary: 'Start a task' })
  @Post(':id/start')
  @HttpCode(202)
  async startTask(@Param('id') id: UUID): Promise<LcpTask> {
    return this.tasks.start(id);
  }

  /** Lists a company's tasks. */
  @ApiOperation({ summary: 'List tasks for a company' })
  @Get()
  async listTasks(@Query('companyId') companyId?: UUID): Promise<LcpTask[]> {
    if (!companyId) {
      throw new BadRequestException('companyId query parameter is required');
    }
    return this.tasks.list(companyId);
  }

  /** Retrieves a task with its assignments. */
  @ApiOperation({ summary: 'Get a task by ID' })
  @Get(':id')
  async getTask(
    @Param('id') id: UUID,
  ): Promise<{ task: LcpTask; assignments: LcpAssignment[] }> {
    return this.tasks.getWithAssignments(id);
  }
}
