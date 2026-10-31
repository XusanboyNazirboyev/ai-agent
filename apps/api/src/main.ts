import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { AppEnvironment } from './config/environment.js';
import { AppModule } from './app.module.js';
import { StructuredLogger } from './observability/structured-logger.js';
import { traceRequests } from './observability/trace-requests.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
    rawBody: true,
  });
  const config = app.get(ConfigService<AppEnvironment, true>);
  const logger = new StructuredLogger(config.get('LOG_LEVEL', { infer: true }));

  app.useLogger(logger);
  app.use(traceRequests);
  await app.listen(
    config.get('PORT', { infer: true }),
    config.get('API_HOST', { infer: true }),
  );
}

void bootstrap();
