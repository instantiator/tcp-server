import { Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

/** Per-service identity for {@link bootstrapMcpApp}. */
export interface McpAppOptions {
  /** The service's root NestJS module. */
  module: Type<unknown>;
  /** Swagger document title, e.g. `'TCP MCP Storage'`. */
  title: string;
  /** One-line Swagger description of what the server exposes. */
  description: string;
  /** Port to listen on when `PORT` is unset. */
  defaultPort: number;
}

/**
 * Boots an MCP server: Swagger on `/swagger`, shutdown hooks enabled, and
 * listening on `PORT` (falling back to the service's own default).
 *
 * Shared by all four MCP services, which differ only in the values above.
 * tcp-server and tcp-agent bootstrap themselves — their extra setup (API-key
 * auth, `requestTimeout`, undici dispatcher) is load-bearing and specific.
 */
export async function bootstrapMcpApp(opts: McpAppOptions): Promise<void> {
  const app = await NestFactory.create(opts.module);

  // Lets Nest run onModuleDestroy/onApplicationShutdown on SIGTERM, so
  // connection pools and queue workers close cleanly on container stop.
  app.enableShutdownHooks();

  const config = new DocumentBuilder()
    .setTitle(opts.title)
    .setDescription(opts.description)
    .setVersion('1.0')
    .build();
  SwaggerModule.setup(
    'swagger',
    app,
    SwaggerModule.createDocument(app, config),
  );

  await app.listen(process.env['PORT'] ?? opts.defaultPort);
}
