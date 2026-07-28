import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Query,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ShutdownStatus, SystemDrainService } from './system-drain.service';

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
@UseGuards(JwtAuthGuard)
@Controller({ path: 'api/system' })
export class SystemController {
  constructor(private readonly drain: SystemDrainService) {}

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
   */
  @ApiOperation({ summary: 'Begin draining the system for shutdown' })
  @Post('shutdown')
  @HttpCode(HttpStatus.ACCEPTED)
  async beginShutdown(@Query('force') force?: string): Promise<ShutdownStatus> {
    // Present-but-empty (`?force`) counts as true, so the flag reads naturally
    // as a bare query parameter; `?force=false` opts back out.
    return this.drain.begin(force !== undefined && force !== 'false');
  }

  /** Reports how far the drain has got. Cheap enough to poll every second. */
  @ApiOperation({ summary: 'Get the current shutdown state' })
  @Get('shutdown')
  async getShutdown(): Promise<ShutdownStatus> {
    return this.drain.status();
  }

  /**
   * Cancels a drain in progress, so the system accepts work again.
   *
   * Agents the drain already paused stay paused: resuming them automatically
   * would be an unrequested burst of token spend. Resume them explicitly via
   * `POST /api/agent/resume/:id`.
   */
  @ApiOperation({ summary: 'Cancel a shutdown in progress' })
  @Delete('shutdown')
  async cancelShutdown(): Promise<ShutdownStatus> {
    return (await this.drain.cancel()) ?? this.drain.status();
  }
}
