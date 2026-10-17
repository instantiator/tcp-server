import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { buildSwaggerDocument } from './swagger-document';

/** Bootstraps the NestJS application and listens on {@link process.env.PORT} (default 3000). */
async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // Run onModuleDestroy hooks on SIGTERM/SIGINT so the BullMQ queue, Redis
  // event relay, and other connections close cleanly on shutdown.
  app.enableShutdownHooks();

  SwaggerModule.setup('swagger', app, buildSwaggerDocument(app));

  await app.listen(process.env['PORT'] ?? 3000);
  // Disable Node.js's built-in 5-minute request timeout so that long-running
  // endpoints (e.g. consultation long-polls in waitForAgentCompletion) are not
  // killed before they can return a response. Application-level timeouts
  // (LLM_TIMEOUT_MS) are still enforced by the service layer.

  (app.getHttpServer() as { requestTimeout: number }).requestTimeout = 0;
}
void bootstrap();
