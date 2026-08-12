import {
  Controller,
  DynamicModule,
  Get,
  Inject,
  Module,
  Res,
} from '@nestjs/common';
import type { HealthDocument, ServiceName } from './service-identity';
import { setHealthRefresh, staticHealthDocument } from './service-identity';

/**
 * The slice of the HTTP response this controller touches. Declared here rather
 * than imported from express so the decorated signature needs no type-only
 * import gymnastics under `isolatedModules` + `emitDecoratorMetadata`.
 */
interface HealthResponse {
  setHeader(name: string, value: string): void;
}

/** Injection token for the name a {@link StaticHealthController} answers as. */
export const STATIC_HEALTH_SERVICE_NAME = 'STATIC_HEALTH_SERVICE_NAME';

/**
 * Exposes `GET /health` for liveness checks on services with no direct
 * infrastructure dependency of their own.
 *
 * These services proxy their work to tcp-server's `/internal/*` endpoints, and
 * Docker Compose already guarantees tcp-server is healthy before they start
 * (`depends_on: condition: service_healthy`). Probing tcp-server from here
 * would add no information and would create a circular health dependency —
 * tcp-server does not probe downstream services either (see docs/database.md's
 * cross-service-communication section). The smoke suite validates the
 * cross-service path instead.
 */
@Controller('health')
export class StaticHealthController {
  constructor(
    @Inject(STATIC_HEALTH_SERVICE_NAME) private readonly name: ServiceName,
  ) {}

  @Get()
  check(@Res({ passthrough: true }) res: HealthResponse): HealthDocument {
    setHealthRefresh(res);
    return staticHealthDocument(this.name);
  }
}

/**
 * Ready-made liveness endpoint for MCP services with no infrastructure
 * dependency to probe. Services that do have one — tcp-mcp-memory, which pings
 * PostgreSQL via Terminus — declare their own health module instead.
 *
 * Takes the service's name so its `/health` says which service answered:
 * three services share this one module, and a health response that can't be
 * attributed is how a misdirected port comes to look healthy.
 */
@Module({})
export class StaticHealthModule {
  static forService(name: ServiceName): DynamicModule {
    return {
      module: StaticHealthModule,
      controllers: [StaticHealthController],
      providers: [{ provide: STATIC_HEALTH_SERVICE_NAME, useValue: name }],
    };
  }
}
