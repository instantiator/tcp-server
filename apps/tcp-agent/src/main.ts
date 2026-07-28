import { NestFactory } from '@nestjs/core';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { Agent, setGlobalDispatcher } from 'undici';
import { AppModule } from './app.module';

// Node's built-in fetch (used for every LLM call, including LM Studio/local
// models) runs on undici, whose default Agent times out a connection after
// 5 minutes of no data — too short for a slow local model still generating
// a long streamed response. tcp-cli's main.ts already raises this for its
// own long-lived SSE reads; this is the same fix for the actual LLM calls
// (a slow generation was previously killed mid-stream with a "terminated"
// error at ~5-6 minutes, well short of the configured 30-minute LLM/agent
// loop timeouts).
setGlobalDispatcher(
  new Agent({ headersTimeout: 35 * 60 * 1000, bodyTimeout: 35 * 60 * 1000 }),
);

/** Bootstraps the tcp-agent service and listens on {@link process.env.PORT} (default 3001). */
async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // Run onModuleDestroy hooks on SIGTERM/SIGINT so the BullMQ worker and its
  // Redis connection close cleanly on shutdown, rather than being killed
  // mid-flight.
  app.enableShutdownHooks();

  const config = new DocumentBuilder()
    .setTitle('TCP Agent')
    .setDescription('Health and status endpoints for the TCP agent worker')
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
