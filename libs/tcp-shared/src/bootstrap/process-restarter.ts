import { Injectable, Logger } from '@nestjs/common';

/** How long to wait before exiting, so the reply and the publish in flight go out first. */
const RESTART_DELAY_MS = 1000;

/**
 * Whether this process runs under something that starts it again when it
 * exits — Docker's `restart: unless-stopped`, in practice. Without one, a
 * restart would just be a stop, so restart is refused instead.
 */
export function restartSupported(value: unknown): boolean {
  return value === true || value === 'true';
}

/**
 * Ends this process so its supervisor starts a fresh one. Sends itself
 * `SIGTERM` rather than calling `process.exit`, so Nest's shutdown hooks
 * close every connection cleanly first.
 *
 * Injectable so tests can replace it: a real call would end the test runner.
 */
@Injectable()
export class ProcessRestarter {
  private readonly logger = new Logger(ProcessRestarter.name);

  /** Exits after a short delay. */
  restart(): void {
    this.logger.warn(`Restarting: exiting in ${RESTART_DELAY_MS} ms`);
    setTimeout(() => process.kill(process.pid, 'SIGTERM'), RESTART_DELAY_MS);
  }
}
