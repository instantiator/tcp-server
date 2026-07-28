import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

/** Bootstraps the NestJS application and listens on {@link process.env.PORT} (default 3000). */
async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // Run onModuleDestroy hooks on SIGTERM/SIGINT so the BullMQ queue, Redis
  // event relay, and other connections close cleanly on shutdown.
  app.enableShutdownHooks();

  const config = new DocumentBuilder()
    .setTitle('TCP Server')
    .setDescription('REST API for the TCP server')
    .setVersion('1.0')
    .addBearerAuth()
    .addApiKey(
      { type: 'apiKey', in: 'header', name: 'x-internal-api-key' },
      'internal-api-key',
    )
    .build();
  SwaggerModule.setup(
    'swagger',
    app,
    SwaggerModule.createDocument(app, config),
  );

  await app.listen(process.env['PORT'] ?? 3000);
  // Disable Node.js's built-in 5-minute request timeout so that long-running
  // endpoints (e.g. consultation long-polls in waitForAgentCompletion) are not
  // killed before they can return a response. Application-level timeouts
  // (LLM_TIMEOUT_MS) are still enforced by the service layer.

  (app.getHttpServer() as { requestTimeout: number }).requestTimeout = 0;
}
void bootstrap();
