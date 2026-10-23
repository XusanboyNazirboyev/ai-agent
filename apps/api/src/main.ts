import { LoggerService } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { AppEnvironment } from './config/environment.js';
import { AppModule } from './app.module.js';

type LogLevel = AppEnvironment['LOG_LEVEL'];

const logPriority: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

class StructuredLogger implements LoggerService {
  constructor(private readonly minimumLevel: LogLevel) {}

  log(message: unknown, ...optionalParams: unknown[]): void {
    this.write('info', message, optionalParams);
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.write('error', message, optionalParams);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.write('warn', message, optionalParams);
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.write('debug', message, optionalParams);
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.write('debug', message, optionalParams);
  }

  fatal(message: unknown, ...optionalParams: unknown[]): void {
    this.write('error', message, optionalParams);
  }

  private write(
    level: LogLevel,
    message: unknown,
    optionalParams: unknown[],
  ): void {
    if (logPriority[level] < logPriority[this.minimumLevel]) return;

    const context = optionalParams.find(
      (param): param is string => typeof param === 'string',
    );
    const stack = optionalParams.find(
      (param): param is string =>
        typeof param === 'string' && param.includes('\n'),
    );
    const record: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      level,
      message: message instanceof Error ? message.message : String(message),
    };

    if (context) record.context = context;
    if (stack) record.stack = stack;
    process.stdout.write(`${JSON.stringify(record)}\n`);
  }
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const config = app.get(ConfigService<AppEnvironment, true>);
  const logger = new StructuredLogger(config.get('LOG_LEVEL', { infer: true }));

  app.useLogger(logger);
  await app.listen(config.get('PORT', { infer: true }), '0.0.0.0');
}

void bootstrap();
