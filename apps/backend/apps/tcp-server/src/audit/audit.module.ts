import {
  AuditEvent,
  InternalApiKeyGuard,
  TcpAgent,
  TcpAssignment,
  TokenUsage,
} from '@tcp/shared';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EventsModule } from '../events/events.module';
import { UsageService } from '../spend/usage.service';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';

/** Provides audit event persistence and the internal POST /internal/audit endpoint. */
@Module({
  imports: [
    TypeOrmModule.forFeature([AuditEvent, TcpAgent, TcpAssignment, TokenUsage]),
    EventsModule,
  ],
  controllers: [AuditController],
  providers: [AuditService, InternalApiKeyGuard, UsageService],
  exports: [AuditService, InternalApiKeyGuard, EventsModule],
})
export class AuditModule {}
