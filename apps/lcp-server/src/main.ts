import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

/** Bootstraps the NestJS application and listens on {@link process.env.PORT} (default 3000). */
async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
