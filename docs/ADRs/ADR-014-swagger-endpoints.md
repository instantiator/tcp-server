# ADR-014: API Documentation (Swagger / OpenAPI)

**Status:** Implemented

## Context

The LCP monorepo exposes HTTP APIs across five NestJS services (`lcp-server`, `lcp-agent`, `lcp-mcp-storage`, `lcp-mcp-memory`, `lcp-mcp-interactions`), but had no machine-readable API documentation. Developers had to read source code or run the server and guess endpoint shapes. There was no built-in way to discover, explore, or test endpoints without writing CLI scripts or reading TypeScript.

## Decision

Add `@nestjs/swagger` (v11, matching NestJS 11) to all five server applications. Each app mounts:

- `GET /swagger` — Swagger UI (interactive HTML)
- `GET /swagger-json` — OpenAPI 3.0 spec (JSON)

The `@nestjs/swagger` CLI plugin is enabled in `nest-cli.json` for each server project. This plugin automatically extracts DTO property descriptions, types, and validation constraints from TypeScript type metadata and TSDoc comments, eliminating the need to manually annotate every DTO field with `@ApiProperty`.

Controller-level enrichment (`@ApiTags`, `@ApiOperation`, `@ApiBearerAuth`, `@ApiSecurity`) is added to all controllers so the generated spec groups endpoints logically and reflects the security requirements of each route.

A new `lcp-cli open-swagger --service <name>` command mirrors `open-document-store` for quick browser access during development.

## Alternatives considered

- **`swagger-ui-dist` without `@nestjs/swagger`**: Would require manually authoring the OpenAPI spec. Ruled out — far more maintenance overhead.
- **Redoc**: An alternative UI renderer. Not chosen — Swagger UI is the NestJS default and sufficient for this use case. Redoc can be layered on top later without changing the OpenAPI spec.
- **Only documenting `lcp-server`**: Rejected — all services expose HTTP endpoints (health checks, MCP protocol) and consistency across the stack is more valuable than the small install cost.

## Consequences

- `GET /swagger` and `GET /swagger-json` are available on all five services.
- The OpenAPI spec is generated at runtime from TypeScript metadata — it stays in sync with the code automatically.
- The CLI plugin must be listed in `nest-cli.json` under each project's `compilerOptions.plugins`; omitting it causes DTO properties to appear as `object` in the spec.
- `swagger-ui-express` is a production dependency. Its bundle (~10 MB) is included in all server images. This is acceptable given the development and operator value.
- `lcp-cli open-swagger --service <name>` prints the Swagger UI URL and (by default) opens it in the system browser. `--no-open` suppresses the browser launch.
- Smoke tests verify that `GET /swagger` returns 200 on each service.
