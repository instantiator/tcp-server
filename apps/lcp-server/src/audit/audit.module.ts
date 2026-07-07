import { AuditEvent, InternalApiKeyGuard } from '@lcp/shared';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';

/** Provides audit event persistence and the internal POST /internal/audit endpoint. */
@Module({
  imports: [TypeOrmModule.forFeature([AuditEvent])],
  controllers: [AuditController],
  providers: [AuditService, InternalApiKeyGuard],
  exports: [AuditService, InternalApiKeyGuard],
})
export class AuditModule {}
