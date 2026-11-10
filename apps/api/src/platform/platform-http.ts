import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import type { z } from 'zod';

export function parseBody<T extends z.ZodType>(
  schema: T,
  body: unknown,
): z.infer<T> {
  const parsed = schema.safeParse(body);
  if (!parsed.success)
    throw new BadRequestException({
      code: 'INVALID_BODY',
      message: 'Invalid body',
      i18nKey: 'errors.invalidBody',
    });
  return parsed.data;
}

export function notFound(): NotFoundException {
  return new NotFoundException({
    code: 'NOT_FOUND',
    message: 'Not found',
    i18nKey: 'errors.notFound',
  });
}

export function conflict(code: string): ConflictException {
  return new ConflictException({
    code,
    message: 'Conflict',
    i18nKey: `platform.errors.${code}`,
  });
}

/** Prisma unique-constraint violation. */
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'P2002'
  );
}
