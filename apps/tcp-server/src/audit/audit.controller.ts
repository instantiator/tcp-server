import { InternalApiKeyGuard } from '@tcp/shared';
import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { AuditService } from './audit.service';
import { CreateAuditEventDto } from './create-audit-event.dto';

/**
 * Internal endpoint for writing audit events from other services.
 *
 * Called by tcp-agent and the MCP servers via {@link AuditClientService}.
 * Protected by {@link InternalApiKeyGuard} — not exposed to end users.
 *
 * permission: (internal service endpoint — no user permission required)
 */
@ApiTags('internal')
@ApiSecurity('internal-api-key')
@Controller('internal/audit')
@UseGuards(InternalApiKeyGuard)
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  /** Records a single audit event. Returns 204 No Content on success. */
  @ApiOperation({ summary: 'Record an audit event (internal)' })
  @Post()
  @HttpCode(204)
  async create(@Body() dto: CreateAuditEventDto): Promise<void> {
    await this.auditService.write(dto);
  }
}
