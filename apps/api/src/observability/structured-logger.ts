import type { LoggerService } from '@nestjs/common';
import type { AppEnvironment } from '../config/environment.js';
import { currentLogContext } from './log-context.js';

type LogLevel = AppEnvironment['LOG_LEVEL'];

const logPriority: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/**
 * One JSON object per line on stdout. Inside a request, job or scan the
 * correlation fields of the current log context are added to the line.
 */
export class StructuredLogger implements LoggerService {
  constructor(
    private readonly minimumLevel: LogLevel,
    private readonly out: (line: string) => void = (line) =>
      process.stdout.write(line),
    private readonly clock: () => Date = () => new Date(),
  ) {}

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
      timestamp: this.clock().toISOString(),
      level,
      message: message instanceof Error ? message.message : String(message),
    };

    if (context) record.context = context;
    if (stack) record.stack = stack;
    const correlation = currentLogContext();
    if (correlation) {
      record.traceId = correlation.traceId;
      if (correlation.tenantId) record.tenantId = correlation.tenantId;
      if (correlation.conversationId)
        record.conversationId = correlation.conversationId;
      if (correlation.language) record.language = correlation.language;
    }
    this.out(`${JSON.stringify(record)}\n`);
  }
}
