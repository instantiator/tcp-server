import { NestFactory } from '@nestjs/core';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';

/** Bootstraps the tcp-mcp-storage service and listens on {@link process.env.PORT} (default 3010). */
async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  const config = new DocumentBuilder()
    .setTitle('LCP MCP Storage')
    .setDescription(
      'MCP server exposing shared company document storage via MinIO',
    )
    .setVersion('1.0')
    .build();
  SwaggerModule.setup(
    'swagger',
    app,
    SwaggerModule.createDocument(app, config),
  );

  await app.listen(process.env['PORT'] ?? 3010);
}
void bootstrap();
