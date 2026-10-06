import { SpendCapState, TokenUsage } from '@tcp/shared';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EventsModule } from '../events/events.module';
import { NotificationModule } from '../notifications/notification.module';
import { SpendCapService } from './spend-cap.service';
import { SpendReportService } from './spend-report.service';
import { UsageService } from './usage.service';

/**
 * Token usage recording and spend-cap evaluation. Imported by the audit layer
 * (every usage-bearing audit write records a row) and by the API layer
 * (reporting, dismissal and resume routes).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([TokenUsage, SpendCapState]),
    NotificationModule,
    EventsModule,
  ],
  providers: [UsageService, SpendCapService, SpendReportService],
  exports: [UsageService, SpendCapService, SpendReportService],
})
export class SpendModule {}
