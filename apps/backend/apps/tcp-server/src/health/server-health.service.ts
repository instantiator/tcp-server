import { assertRedisReachable, serviceIdentity } from '@tcp/shared';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  HealthCheckResult,
  HealthCheckService,
  HealthIndicatorResult,
  HttpHealthIndicator,
  TypeOrmHealthIndicator,
} from '@nestjs/terminus';

/**
 * tcp-server's own health checks: PostgreSQL, Redis, MinIO and the OIDC
 * provider. Shared by `GET /health` and the combined system health report, so
 * the two can never disagree about what tcp-server checks.
 */
@Injectable()
export class ServerHealthService {
  constructor(
    private readonly health: HealthCheckService,
    private readonly db: TypeOrmHealthIndicator,
    private readonly http: HttpHealthIndicator,
    private readonly config: ConfigService,
  ) {}

  /**
   * Runs every check. Resolves with the Terminus document when all pass, and
   * throws Terminus's `ServiceUnavailableException` (carrying the same
   * document) when any fail.
   */
  check(): Promise<HealthCheckResult> {
    const minioEndpoint = this.config.get<string>('MINIO_ENDPOINT') ?? '';
    // Prefer the internal URL for health checks so the probe works from inside Docker.
    const oidcIssuer =
      this.config.get<string>('OIDC_INTERNAL_ISSUER_URL') ??
      this.config.get<string>('OIDC_ISSUER_URL') ??
      '';
    return this.health.check([
      // Names the responding service in both the 200 and the 503 body — see
      // `serviceIdentity`. First, so it heads the document.
      () => serviceIdentity('tcp-server'),
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
   * Reports Redis liveness. tcp-server depends on Redis for the agent-jobs
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
