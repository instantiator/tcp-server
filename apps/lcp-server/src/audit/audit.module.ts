import {
  AuditEvent,
  InternalApiKeyGuard,
  LcpAgent,
  LcpAssignment,
} from '@lcp/shared';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EventsModule } from '../events/events.module';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';

/** Provides audit event persistence and the internal POST /internal/audit endpoint. */
@Module({
  imports: [
    TypeOrmModule.forFeature([AuditEvent, LcpAgent, LcpAssignment]),
    EventsModule,
  ],
  controllers: [AuditController],
  providers: [AuditService, InternalApiKeyGuard],
  exports: [AuditService, InternalApiKeyGuard, EventsModule],
})
export class AuditModule {}
