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
    // Check the master realm discovery URL: it's always present on a fresh
    // Keycloak (unlike a custom realm), is served on the main port 8080, and
    // confirms OIDC is actually serving requests. Keycloak 24+ moved /health/ready
    // to a separate management port (9000) that we don't expose.
    const oidcBaseUrl = new URL(oidcIssuer).origin;
    return this.health.check([
      () => this.db.pingCheck('database'),
      () => this.pingRedis(),
      () => this.http.pingCheck('minio', `${minioEndpoint}/minio/health/live`),
      () =>
        this.http.pingCheck(
          'oidc',
          `${oidcBaseUrl}/realms/master/.well-known/openid-configuration`,
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
