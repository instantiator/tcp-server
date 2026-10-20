import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { UUID } from 'crypto';
import type { Request } from 'express';
import { getCurrentUserId } from '../auth/current-user';
import { CompanyMembershipGuard } from '../auth/company-membership.guard';
import { CompanyScope } from '../auth/company-scope.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import {
  CreateMemoryDto,
  MemoryDto,
  MemoryListDto,
  UpdateMemoryDto,
} from './dto/memory.dto';
import { MemoryService } from './memory.service';

/**
 * A role's memories, for people (002.06). Every route is scoped through the
 * role to its company, and every memory lookup is by role and id together,
 * so a memory id from another role is simply not found.
 */
@ApiTags('memory')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CompanyMembershipGuard)
@Controller('api/role/:roleId/memory')
export class MemoryController {
  constructor(private readonly memories: MemoryService) {}

  @ApiOperation({ summary: "List a role's memories, newest first" })
  @ApiOkResponse({ type: MemoryListDto })
  @CompanyScope({ from: 'param', key: 'roleId', via: 'role' })
  @Get()
  list(@Param('roleId', ParseUUIDPipe) roleId: UUID): Promise<MemoryListDto> {
    return this.memories.list(roleId);
  }

  @ApiOperation({ summary: 'Add a memory to a role' })
  @ApiCreatedResponse({ type: MemoryDto })
  @CompanyScope({ from: 'param', key: 'roleId', via: 'role' })
  @Post()
  create(
    @Param('roleId', ParseUUIDPipe) roleId: UUID,
    @Body() body: CreateMemoryDto,
    @Req() req: Request,
  ): Promise<MemoryDto> {
    return this.memories.create(roleId, body, getCurrentUserId(req));
  }

  @ApiOperation({ summary: "Change a memory's content or tags" })
  @ApiOkResponse({ type: MemoryDto })
  @CompanyScope({ from: 'param', key: 'roleId', via: 'role' })
  @Patch(':id')
  update(
    @Param('roleId', ParseUUIDPipe) roleId: UUID,
    @Param('id', ParseUUIDPipe) id: UUID,
    @Body() body: UpdateMemoryDto,
    @Req() req: Request,
  ): Promise<MemoryDto> {
    return this.memories.update(roleId, id, body, getCurrentUserId(req));
  }

  @ApiOperation({ summary: 'Delete a memory' })
  @ApiNoContentResponse()
  @CompanyScope({ from: 'param', key: 'roleId', via: 'role' })
  @Delete(':id')
  @HttpCode(204)
  remove(
    @Param('roleId', ParseUUIDPipe) roleId: UUID,
    @Param('id', ParseUUIDPipe) id: UUID,
    @Req() req: Request,
  ): Promise<void> {
    return this.memories.remove(roleId, id, getCurrentUserId(req));
  }
}
