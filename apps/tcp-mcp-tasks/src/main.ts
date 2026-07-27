import { NestFactory } from '@nestjs/core';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';

/** Bootstraps the tcp-mcp-tasks service and listens on {@link process.env.PORT} (default 3013). */
async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  const config = new DocumentBuilder()
    .setTitle('LCP MCP Tasks')
    .setDescription(
      'MCP server for task planning, assignment completion, and QA assurance',
    )
    .setVersion('1.0')
    .build();
  SwaggerModule.setup(
    'swagger',
    app,
    SwaggerModule.createDocument(app, config),
  );

  await app.listen(process.env['PORT'] ?? 3013);
}
void bootstrap();
