import { NestFactory } from '@nestjs/core';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';

/** Bootstraps the tcp-mcp-memory service and listens on {@link process.env.PORT} (default 3011). */
async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  const config = new DocumentBuilder()
    .setTitle('TCP MCP Memory')
    .setDescription(
      'MCP server for agent episodic memory retrieval and storage via pgvector',
    )
    .setVersion('1.0')
    .build();
  SwaggerModule.setup(
    'swagger',
    app,
    SwaggerModule.createDocument(app, config),
  );

  await app.listen(process.env['PORT'] ?? 3011);
}
void bootstrap();
