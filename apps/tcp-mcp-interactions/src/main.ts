import { NestFactory } from '@nestjs/core';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';

/** Bootstraps the tcp-mcp-interactions service and listens on {@link process.env.PORT} (default 3012). */
async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  const config = new DocumentBuilder()
    .setTitle('LCP MCP Interactions')
    .setDescription(
      'MCP server for human-in-the-loop interactions, consultations, and task completion',
    )
    .setVersion('1.0')
    .build();
  SwaggerModule.setup(
    'swagger',
    app,
    SwaggerModule.createDocument(app, config),
  );

  await app.listen(process.env['PORT'] ?? 3012);
}
void bootstrap();
