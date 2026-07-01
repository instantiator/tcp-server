import { NestFactory } from '@nestjs/core';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';

/** Bootstraps the NestJS application and listens on {@link process.env.PORT} (default 3000). */
async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  const config = new DocumentBuilder()
    .setTitle('LCP Server')
    .setDescription('REST API for the Little Computer People LCP server')
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
  app.getHttpServer().requestTimeout = 0;
}
void bootstrap();
