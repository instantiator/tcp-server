import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { AuditService } from './audit.service';
import { CreateAuditEventDto } from './create-audit-event.dto';
import { InternalApiKeyGuard } from './internal-api-key.guard';

/**
 * Internal endpoint for writing audit events from other services.
 *
 * Called by lcp-agent and the MCP servers via {@link AuditClientService}.
 * Protected by {@link InternalApiKeyGuard} — not exposed to end users.
 *
 * permission: (internal service endpoint — no user permission required)
 */
@Controller('internal/audit')
@UseGuards(InternalApiKeyGuard)
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  /** Records a single audit event. Returns 204 No Content on success. */
  @Post()
  @HttpCode(204)
  async create(@Body() dto: CreateAuditEventDto): Promise<void> {
    await this.auditService.write(dto);
  }
}
