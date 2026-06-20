import { Controller, Get } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  HttpHealthIndicator,
  TypeOrmHealthIndicator,
} from '@nestjs/terminus';
import { ConfigService } from '@nestjs/config';

/**
 * Exposes `GET /health` to report the liveness of lcp-server's dependencies:
 * PostgreSQL, MinIO, and the OIDC provider.
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
   * Runs health checks against the database, MinIO, and the OIDC provider.
   * Returns HTTP 200 when all checks pass, 503 when any fail.
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
      () => this.http.pingCheck('minio', `${minioEndpoint}/minio/health/live`),
      () =>
        this.http.pingCheck(
          'oidc',
          `${oidcBaseUrl}/realms/master/.well-known/openid-configuration`,
        ),
    ]);
  }
}
