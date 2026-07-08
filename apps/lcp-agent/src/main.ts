import { NestFactory } from '@nestjs/core';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';

/** Bootstraps the lcp-agent service and listens on {@link process.env.PORT} (default 3001). */
async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // Run onModuleDestroy hooks on SIGTERM/SIGINT so the BullMQ worker and its
  // Redis connection close cleanly on shutdown, rather than being killed
  // mid-flight.
  app.enableShutdownHooks();

  const config = new DocumentBuilder()
    .setTitle('LCP Agent')
    .setDescription('Health and status endpoints for the LCP agent worker')
    .setVersion('1.0')
    .build();
  SwaggerModule.setup(
    'swagger',
    app,
    SwaggerModule.createDocument(app, config),
  );

  await app.listen(process.env['PORT'] ?? 3001);
}
void bootstrap();
