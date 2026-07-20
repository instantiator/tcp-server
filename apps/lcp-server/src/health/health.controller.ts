import { assertRedisReachable } from '@lcp/shared';
import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  HealthCheck,
  HealthCheckService,
  HealthIndicatorResult,
  HttpHealthIndicator,
  TypeOrmHealthIndicator,
} from '@nestjs/terminus';

/**
 * Exposes `GET /health` to report the liveness of lcp-server's dependencies:
 * PostgreSQL, Redis, MinIO, and the OIDC provider.
 */
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly db: TypeOrmHealthIndicator,
    private readonly http: HttpHealthIndicator,
    private readonly config: ConfigService,
  ) {}

  /**
   * Runs health checks against the database, Redis, MinIO, and the OIDC
   * provider. Returns HTTP 200 when all checks pass, 503 when any fail.
   */
  @Get()
  @HealthCheck()
  check() {
    const minioEndpoint = this.config.get<string>('MINIO_ENDPOINT') ?? '';
    // Prefer the internal URL for health checks so the probe works from inside Docker.
    const oidcIssuer =
      this.config.get<string>('OIDC_INTERNAL_ISSUER_URL') ??
      this.config.get<string>('OIDC_ISSUER_URL') ??
      '';
    return this.health.check([
      () => this.db.pingCheck('database'),
      () => this.pingRedis(),
      () => this.http.pingCheck('minio', `${minioEndpoint}/minio/health/live`),
      () =>
        this.http.pingCheck(
          'oidc',
          `${oidcIssuer.replace(/\/$/, '')}/.well-known/openid-configuration`,
          // Host-based instance routing (e.g. Zitadel) rejects requests reached
          // via an internal Docker network address whose Host header doesn't
          // match the provider's configured external domain — forward the real
          // external host so it can still resolve the right instance.
          {
            headers: {
              'X-Forwarded-Host': new URL(
                this.config.getOrThrow<string>('OIDC_ISSUER_URL'),
              ).host,
            },
          },
        ),
    ]);
  }

  /**
   * Reports Redis liveness. lcp-server depends on Redis for the agent-jobs
   * BullMQ queue and the event relay, so a downed Redis should surface here.
   * Uses the shared bounded reachability probe so the check itself cannot hang.
   */
  private async pingRedis(): Promise<HealthIndicatorResult> {
    const url = this.config.getOrThrow<string>('REDIS_URL');
    try {
      await assertRedisReachable(url);
      return { redis: { status: 'up' } };
    } catch (err) {
      return {
        redis: {
          status: 'down',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }
}
