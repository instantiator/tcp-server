import { TcpNotification } from '@tcp/shared';
import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { UUID } from 'crypto';
import { CompanyMembershipGuard } from '../auth/company-membership.guard';
import { NoCompanyScope } from '../auth/company-scope.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { NotificationService } from './notification.service';

/**
 * Application-wide notices — spend thresholds and caps today, more kinds
 * later (003.03). Every signed-in user sees the same list, and a dismissal
 * applies to everyone.
 */
@ApiTags('notifications')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CompanyMembershipGuard)
@Controller({ path: 'api/notifications' })
export class NotificationController {
  constructor(private readonly notifications: NotificationService) {}

  /** Lists active notifications, newest first; `?includeDismissed` adds dismissed ones. */
  @ApiOperation({ summary: 'List notifications' })
  @ApiQuery({
    name: 'includeDismissed',
    required: false,
    type: Boolean,
    description:
      'Also return dismissed notifications. Bare `?includeDismissed` counts as true.',
  })
  @ApiOkResponse({ type: TcpNotification, isArray: true })
  @NoCompanyScope('application-wide notices; visible to every signed-in user')
  @Get()
  list(
    @Query('includeDismissed') includeDismissed?: string,
  ): Promise<TcpNotification[]> {
    return this.notifications.list(
      includeDismissed === '' || includeDismissed === 'true',
    );
  }

  /** Dismisses a notification for every user. Idempotent. */
  @ApiOperation({ summary: 'Dismiss a notification' })
  @ApiOkResponse({ type: TcpNotification })
  @NoCompanyScope('application-wide notices; any signed-in user may dismiss')
  @Post(':id/dismiss')
  @HttpCode(HttpStatus.OK)
  dismiss(
    @Param('id', new ParseUUIDPipe()) id: UUID,
  ): Promise<TcpNotification> {
    return this.notifications.dismiss(id);
  }
}
