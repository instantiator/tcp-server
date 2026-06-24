import { Controller, Get } from '@nestjs/common';

/** Exposes `GET /health` for liveness checks. */
@Controller('health')
export class HealthController {
  /** Returns a static ok response — no external dependencies to check. */
  @Get()
  check(): { status: string } {
    return { status: 'ok' };
  }
}
