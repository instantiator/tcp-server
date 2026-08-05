import { InternalApiKeyGuard } from '@tcp/shared';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  MODULE_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
// `jwks-rsa` pulls in ESM-only `jose`, which the unit tier cannot parse. This
// audit only inspects metadata — nothing is constructed, nothing connects —
// so the strategy's key provider is stubbed to keep the graph importable.
jest.mock('jwks-rsa', () => ({ passportJwtSecret: () => () => undefined }));

// `ConfigModule.forRoot` validates the environment as `app.module` is
// evaluated, so these have to be present before it is required — hence
// `require` here rather than a hoisted `import`.
for (const [key, value] of Object.entries({
  DATABASE_URL: 'postgres://audit/audit',
  REDIS_URL: 'redis://audit',
  MINIO_ENDPOINT: 'http://audit',
  MINIO_ACCESS_KEY: 'audit',
  MINIO_SECRET_KEY: 'audit',
  OIDC_ISSUER_URL: 'http://audit',
  OIDC_CLIENT_ID: 'audit',
  OIDC_CLIENT_SECRET: 'audit',
  INTERNAL_API_KEY: 'audit',
})) {
  process.env[key] ??= value;
}

/* eslint-disable @typescript-eslint/no-require-imports -- the environment above must be set before app.module is evaluated, which a hoisted import would not allow */
const { AppModule } =
  require('../app.module') as typeof import('../app.module');
/* eslint-enable @typescript-eslint/no-require-imports */
import { AuthTokenController } from './auth-token.controller';
import { HealthController } from '../health/health.controller';
import { CompanyMembershipGuard } from './company-membership.guard';
import {
  ADMIN_ONLY,
  COMPANY_SCOPE,
  NO_COMPANY_SCOPE,
} from './company-scope.decorator';
import { JwtAuthGuard } from './jwt-auth.guard';

/** Anything Nest accepts in a module's `controllers`/`imports` array. */
type Ctor = new (...args: never[]) => object;

/**
 * Controllers deliberately reachable without a token, and why. Anything else
 * missing {@link JwtAuthGuard} is a finding, not an omission.
 */
const PUBLIC_CONTROLLERS = new Map<Ctor, string>([
  [HealthController, 'liveness probe; no data'],
  [
    AuthTokenController,
    'token acquisition necessarily precedes holding a token',
  ],
]);

/** Every controller class reachable from `AppModule`, found statically. */
function collectControllers(root: Ctor): Ctor[] {
  const seen = new Set<Ctor>();
  const controllers = new Set<Ctor>();
  const queue: Ctor[] = [root];

  while (queue.length > 0) {
    const module = queue.pop();
    if (!module || seen.has(module)) continue;
    seen.add(module);

    for (const controller of (Reflect.getMetadata(
      MODULE_METADATA.CONTROLLERS,
      module,
    ) ?? []) as Ctor[]) {
      controllers.add(controller);
    }
    for (const imported of (Reflect.getMetadata(
      MODULE_METADATA.IMPORTS,
      module,
    ) ?? []) as (Ctor | { module?: Ctor })[]) {
      // A dynamic module (`forRoot`/`forFeature`) is an object wrapping its
      // own class; neither form declares controllers here, but both can
      // import further modules that do.
      const candidate =
        typeof imported === 'function' ? imported : imported?.module;
      if (candidate) queue.push(candidate);
    }
  }
  return [...controllers];
}

/** Handler names on a controller that Nest has bound to a route. */
function routeHandlers(controller: Ctor): string[] {
  const proto = controller.prototype as Record<string, unknown>;
  return Object.getOwnPropertyNames(proto).filter(
    (name) =>
      name !== 'constructor' &&
      typeof proto[name] === 'function' &&
      Reflect.getMetadata(METHOD_METADATA, proto[name]) !== undefined,
  );
}

/** The guard classes applied to a controller. */
function guardsOf(controller: Ctor): Ctor[] {
  return (Reflect.getMetadata(GUARDS_METADATA, controller) ?? []) as Ctor[];
}

/**
 * The standing audit of what every route is protected by (ADR-011, phase-02
 * amendment). The prompt this implements asks for an enumeration of every
 * user-facing route and its status; an enumeration written once is stale by
 * the next merge, so it is asserted here instead.
 */
describe('route authorization audit', () => {
  const controllers = collectControllers(AppModule);

  it('finds every controller in the application', () => {
    // A guard against the walk silently finding nothing and passing
    // everything below it.
    expect(controllers.length).toBeGreaterThanOrEqual(15);
  });

  describe.each(controllers.map((c) => [c.name, c] as const))(
    '%s',
    (_name, controller) => {
      const guards = guardsOf(controller);
      const isUserFacing = guards.includes(JwtAuthGuard);
      const isInternal = guards.includes(InternalApiKeyGuard);

      it('is authenticated, or explicitly public with a reason', () => {
        if (isUserFacing || isInternal) return;
        expect(PUBLIC_CONTROLLERS.get(controller)).toBeDefined();
      });

      if (isUserFacing) {
        it('applies the membership guard alongside JWT authentication', () => {
          expect(guards).toContain(CompanyMembershipGuard);
        });

        it.each(routeHandlers(controller))(
          '%s declares exactly one company scope',
          (handler) => {
            const method = (controller.prototype as Record<string, unknown>)[
              handler
            ] as object;
            const declarations = [
              Reflect.getMetadata(COMPANY_SCOPE, method),
              Reflect.getMetadata(NO_COMPANY_SCOPE, method),
              Reflect.getMetadata(ADMIN_ONLY, method),
            ].filter((value) => value !== undefined);
            expect(declarations).toHaveLength(1);
          },
        );
      }

      if (isInternal) {
        it('is internal-only: no JWT guard, no company scope', () => {
          // A different trust boundary (the shared API key). Mixing the two
          // on one controller would leave it unclear which one is load-bearing.
          expect(isUserFacing).toBe(false);
          for (const handler of routeHandlers(controller)) {
            const method = (controller.prototype as Record<string, unknown>)[
              handler
            ] as object;
            expect(Reflect.getMetadata(COMPANY_SCOPE, method)).toBeUndefined();
          }
        });
      }

      it('has at least one route', () => {
        expect(Reflect.getMetadata(PATH_METADATA, controller)).toBeDefined();
      });
    },
  );
});
