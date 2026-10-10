import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Query,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  ApiAcceptedResponse,
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CompanyMembershipGuard } from '../auth/company-membership.guard';
import { AdminOnly, NoCompanyScope } from '../auth/company-scope.decorator';
import { getCurrentUserIdentifiers } from '../auth/current-user';
import { MembershipService } from '../auth/membership.service';
import { ShutdownStatus, SystemDrainService } from './system-drain.service';
import { SystemHealth, SystemHealthService } from './system-health.service';
import { SystemShutdownService } from './system-shutdown.service';
import {
  ShutdownStatusResponseDto,
  SystemHealthResponseDto,
  SystemStatusResponseDto,
} from './dto/system.dto';

/**
 * Fleet-level lifecycle control — the only endpoints that act on the whole
 * simulation rather than one agent or task.
 *
 * These endpoints drain; they do not halt. Every Compose service runs with
 * `restart: unless-stopped`, so a process that exited itself would simply be
 * restarted; halting is the host wrapper's job (`docker compose stop`), once
 * this reports the system quiesced. See ADR-019.
 */
@ApiTags('system')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CompanyMembershipGuard)
@Controller({ path: 'api/system' })
export class SystemController {
  constructor(
    private readonly drain: SystemDrainService,
    private readonly health: SystemHealthService,
    private readonly shutdown: SystemShutdownService,
    private readonly membership: MembershipService,
  ) {}

  /**
   * Tells any signed-in user whether they are an administrator (so the web
   * client knows to offer the System menu) and whether the system is shutting
   * down (so every user sees the banner). Deliberately small: the full drain
   * progress stays admin-only.
   */
  @ApiOperation({ summary: 'Get the caller-facing system status' })
  @NoCompanyScope("system-wide state; reveals only the caller's own admin flag")
  @Get('status')
  @ApiOkResponse({ type: SystemStatusResponseDto })
  getStatus(@Req() req: Request): SystemStatusResponseDto {
    return {
      admin: this.membership.isAdmin(getCurrentUserIdentifiers(req)),
      shutdown: {
        state: this.shutdown.currentState,
        restart: this.shutdown.isRestarting,
      },
    };
  }

  /**
   * Every service's health in one report. A down service is reported in the
   * body, never as an error status, so the caller always gets the details.
   */
  @ApiOperation({ summary: 'Get the health of every service' })
  @AdminOnly()
  @Get('health')
  @ApiOkResponse({ type: SystemHealthResponseDto })
  getHealth(): Promise<SystemHealth> {
    return this.health.check();
  }

  /**
   * Begins draining towards a shutdown, and returns immediately with a
   * progress snapshot — poll {@link getShutdown} to watch it finish.
   *
   * Graceful (the default) pauses each running agent at its next resumable
   * point, after the LLM has answered, so no spent tokens are wasted. `force`
   * aborts in-flight LLM calls instead, which does waste whatever those calls
   * have cost so far.
   *
   * Idempotent, except that `force` always escalates a graceful drain already
   * in progress.
   *
   * `restart` ends the drain by restarting tcp-server and tcp-agent instead of
   * waiting for the host to halt them, and the work it paused carries on by
   * itself after the restart. It is refused (409) where nothing would start
   * the services again, and while a plain shutdown is already draining.
   */
  @ApiOperation({
    summary: 'Begin draining the system for shutdown or restart',
  })
  @AdminOnly()
  @Post('shutdown')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiAcceptedResponse({ type: ShutdownStatusResponseDto })
  async beginShutdown(
    @Query('force') force?: string,
    @Query('restart') restart?: string,
  ): Promise<ShutdownStatus> {
    return this.drain.begin(isSet(force), isSet(restart));
  }

  /** Reports how far the drain has got. Cheap enough to poll every second. */
  @ApiOperation({ summary: 'Get the current shutdown state' })
  @AdminOnly()
  @Get('shutdown')
  @ApiOkResponse({ type: ShutdownStatusResponseDto })
  async getShutdown(): Promise<ShutdownStatus> {
    return this.drain.status();
  }

  /**
   * Cancels a drain in progress, so the system accepts work again.
   *
   * Agents the drain already paused stay paused: resuming them automatically
   * would be an unrequested burst of token spend. Resume them explicitly, by
   * task (`POST /api/task/:id/resume`) or by company.
   */
  @ApiOperation({ summary: 'Cancel a shutdown in progress' })
  @AdminOnly()
  @Delete('shutdown')
  @ApiOkResponse({ type: ShutdownStatusResponseDto })
  async cancelShutdown(): Promise<ShutdownStatus> {
    return (await this.drain.cancel()) ?? this.drain.status();
  }
}

/**
 * A boolean query flag. Present-but-empty (`?force`) counts as true, so the
 * flag reads naturally as a bare query parameter; `?force=false` opts out.
 */
function isSet(flag?: string): boolean {
  return flag !== undefined && flag !== 'false';
}
