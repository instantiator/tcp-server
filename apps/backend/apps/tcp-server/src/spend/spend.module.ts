import { SpendCapState, TokenUsage } from '@tcp/shared';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NotificationModule } from '../notifications/notification.module';
import { SpendCapService } from './spend-cap.service';
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
  ],
  providers: [UsageService, SpendCapService],
  exports: [UsageService, SpendCapService],
})
export class SpendModule {}
