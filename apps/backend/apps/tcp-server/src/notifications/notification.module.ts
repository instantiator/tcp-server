import { TcpCompany, TcpNotification } from '@tcp/shared';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { EventsModule } from '../events/events.module';
import { NotificationController } from './notification.controller';
import { NotificationService } from './notification.service';

/**
 * Application-wide notifications: the REST routes, and the service other
 * modules (spend caps, company priming) use to raise and replay them.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([TcpNotification, TcpCompany]),
    EventsModule,
    AuthModule,
  ],
  controllers: [NotificationController],
  providers: [NotificationService],
  exports: [NotificationService],
})
export class NotificationModule {}
