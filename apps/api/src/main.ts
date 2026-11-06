import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { AppEnvironment } from './config/environment.js';
import { AppModule } from './app.module.js';
import { StructuredLogger } from './observability/structured-logger.js';
import { traceRequests } from './observability/trace-requests.js';
import { configureHttp } from './http/security-headers.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    rawBody: true,
  });
  const config = app.get(ConfigService<AppEnvironment, true>);
  const logger = new StructuredLogger(config.get('LOG_LEVEL', { infer: true }));

  app.useLogger(logger);
  app.use(traceRequests);
  configureHttp(app);
  await app.listen(
    config.get('PORT', { infer: true }),
    config.get('API_HOST', { infer: true }),
  );
}

void bootstrap();
