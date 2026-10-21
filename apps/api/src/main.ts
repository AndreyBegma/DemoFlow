import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  configureApp(app);

  const port = process.env.PORT ?? 8370;
  await app.listen(port);
  console.log(`API running on http://localhost:${port}`);
}

bootstrap();
