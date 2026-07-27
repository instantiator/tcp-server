import {
  CONTEXT_AUDIT_SINK,
  ContextBudgetService,
  ContextCompactorService,
  ContextManagerService,
  IncomingDataGuardService,
  OVERFLOW_STORE,
} from '@tcp/shared';
import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuditService } from '../audit/audit.service';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';

/**
 * Provides context-budget and compaction services to the API layer.
 * Compaction rows are written via {@link CONTEXT_AUDIT_SINK} ({@link
 * AuditService}) and streamed live by the persist-then-publish path — this
 * module no longer wires an event sink of its own.
 */
@Module({
  imports: [AuditModule, StorageModule],
  providers: [
    ContextBudgetService,
    ContextCompactorService,
    { provide: OVERFLOW_STORE, useExisting: StorageService },
    IncomingDataGuardService,
    { provide: CONTEXT_AUDIT_SINK, useExisting: AuditService },
    ContextManagerService,
  ],
  exports: [
    ContextBudgetService,
    ContextCompactorService,
    IncomingDataGuardService,
    ContextManagerService,
  ],
})
export class ContextModule {}
