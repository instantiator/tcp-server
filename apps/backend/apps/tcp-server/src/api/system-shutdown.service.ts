import {
  ConflictException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';

/**
 * Where the system is in the shutdown lifecycle.
 *
 * - `idle` — accepting work as normal.
 * - `draining` — refusing new work; running agents are being brought to rest.
 * - `quiesced` — draining finished; nothing is running and it is safe to halt.
 */
export type ShutdownState = 'idle' | 'draining' | 'quiesced';

/**
 * The single source of truth for whether tcp-server is draining towards a
 * shutdown, and the guard every intake path consults before accepting work.
 *
 * Deliberately holds no persistence: the state resets to `idle` on boot, so a
 * restarted stack always comes back accepting work rather than still refusing
 * it. Agents paused by a drain stay paused (recorded on the agent row itself)
 * and are resumed explicitly by a user.
 */
@Injectable()
export class SystemShutdownService {
  private readonly logger = new Logger(SystemShutdownService.name);
  private state: ShutdownState = 'idle';
  private forced = false;
  private restarting = false;

  /** The current lifecycle state. */
  get currentState(): ShutdownState {
    return this.state;
  }

  /** True once the current drain was requested with `--force`. */
  get isForced(): boolean {
    return this.forced;
  }

  /** True when the current drain ends in a restart rather than a halt. */
  get isRestarting(): boolean {
    return this.restarting;
  }

  /**
   * True from the moment a drain begins until it is cancelled — including
   * after quiescing, since a quiesced system is waiting to be halted and must
   * not quietly start accepting work again.
   */
  get isShuttingDown(): boolean {
    return this.state !== 'idle';
  }

  /**
   * Begins (or escalates) a drain.
   *
   * Idempotent: a second graceful request while already draining changes
   * nothing. A forced request always upgrades an in-progress graceful drain,
   * because forcing is an explicit user action, never an automatic escalation.
   * A drain can't switch between a shutdown and a restart: that is refused,
   * because the agents already paused carry the other kind's reason.
   *
   * @returns `true` when this call changed the state.
   */
  begin(force: boolean, restart = false): boolean {
    if (this.isShuttingDown && restart !== this.restarting) {
      throw new ConflictException(
        'A shutdown is already in progress. Cancel it first.',
      );
    }
    const escalating = force && !this.forced;
    if (this.isShuttingDown && !escalating) return false;

    this.state = 'draining';
    this.forced = this.forced || force;
    this.restarting = restart;
    this.logger.warn(
      `System draining for ${restart ? 'restart' : 'shutdown'} (${this.forced ? 'forced' : 'graceful'})`,
    );
    return true;
  }

  /**
   * Records that every running agent has come to rest.
   * Ignored unless a drain is in progress.
   *
   * @returns `true` when this call changed the state.
   */
  markQuiesced(): boolean {
    if (this.state !== 'draining') return false;
    this.state = 'quiesced';
    this.logger.warn('System quiesced — no agents running, safe to halt');
    return true;
  }

  /**
   * Cancels a drain, so the system accepts work again.
   *
   * Agents already paused by the drain stay paused: resuming them here would
   * be a surprise burst of token spend, so a user resumes them explicitly.
   *
   * @returns `true` when a drain was actually in progress.
   */
  cancel(): boolean {
    if (!this.isShuttingDown) return false;
    this.state = 'idle';
    this.forced = false;
    this.restarting = false;
    this.logger.warn('Shutdown drain cancelled — accepting work again');
    return true;
  }

  /**
   * Rejects an intake request with `503 Service Unavailable` while the system
   * is draining. Call at the top of any path that starts new agent work.
   */
  assertAccepting(): void {
    if (!this.isShuttingDown) return;
    if (this.restarting) {
      throw new ServiceUnavailableException(
        'The system is restarting and is not accepting new work. Try again in a minute.',
      );
    }
    throw new ServiceUnavailableException(
      'The system is shutting down and is not accepting new work. ' +
        'Cancel the shutdown (DELETE /api/system/shutdown) to resume normal service.',
    );
  }
}
