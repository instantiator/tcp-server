import { TcpNotification } from '@tcp/shared';
import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { UUID } from 'crypto';
import { CompanyMembershipGuard } from '../auth/company-membership.guard';
import { CompanyScope, NoCompanyScope } from '../auth/company-scope.decorator';
import { getCurrentUserIdentifiers } from '../auth/current-user';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { MembershipService } from '../auth/membership.service';
import { NotificationService } from './notification.service';

/**
 * Notices: application-wide ones (spend thresholds and caps), which every
 * signed-in user sees, and a company's own (a task failed, or a shutdown
 * paused it), which only its members see. A dismissal applies to everyone
 * who can see the notice.
 */
@ApiTags('notifications')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CompanyMembershipGuard)
@Controller({ path: 'api/notifications' })
export class NotificationController {
  constructor(
    private readonly notifications: NotificationService,
    private readonly membership: MembershipService,
  ) {}

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

  /**
   * Lists the application-wide notifications plus one company's own, newest
   * first; `?includeDismissed` adds dismissed ones.
   */
  @ApiOperation({ summary: "List a company's notifications" })
  @ApiQuery({
    name: 'includeDismissed',
    required: false,
    type: Boolean,
    description:
      'Also return dismissed notifications. Bare `?includeDismissed` counts as true.',
  })
  @ApiOkResponse({ type: TcpNotification, isArray: true })
  @CompanyScope({ from: 'param', key: 'companyId', via: 'company' })
  @Get('company/:companyId')
  listForCompany(
    @Param('companyId', new ParseUUIDPipe()) companyId: UUID,
    @Query('includeDismissed') includeDismissed?: string,
  ): Promise<TcpNotification[]> {
    return this.notifications.listForCompany(
      companyId,
      includeDismissed === '' || includeDismissed === 'true',
    );
  }

  /**
   * Dismisses a notification for everyone who can see it. Idempotent. A
   * company's own notice may be dismissed only by its members (or an
   * administrator); to anyone else it doesn't exist (404), so its id is no
   * oracle for its content.
   */
  @ApiOperation({ summary: 'Dismiss a notification' })
  @ApiOkResponse({ type: TcpNotification })
  @NoCompanyScope(
    "an application-wide notice names no company; a company's own notice is membership-checked in the handler",
  )
  @Post(':id/dismiss')
  @HttpCode(HttpStatus.OK)
  async dismiss(
    @Param('id', new ParseUUIDPipe()) id: UUID,
    @Req() req: Request,
  ): Promise<TcpNotification> {
    const notification = await this.notifications.findOne(id);
    if (notification?.companyId) {
      const identifiers = getCurrentUserIdentifiers(req);
      const allowed =
        this.membership.isAdmin(identifiers) ||
        (await this.membership.isMember(identifiers, notification.companyId));
      if (!allowed) throw new NotFoundException(`Notification ${id} not found`);
    }
    return this.notifications.dismiss(id);
  }
}
