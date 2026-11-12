import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';

/** HTTP error bodies of the tags and custom fields API (ADR 053). */
export const notFound = (): NotFoundException =>
  new NotFoundException({
    code: 'NOT_FOUND',
    message: 'Not found',
    i18nKey: 'errors.notFound',
  });
export const forbidden = (): ForbiddenException =>
  new ForbiddenException({
    code: 'FORBIDDEN',
    message: 'Not allowed',
    i18nKey: 'errors.forbidden',
  });
export const invalidBody = (): BadRequestException =>
  new BadRequestException({
    code: 'INVALID_BODY',
    message: 'Invalid body',
    i18nKey: 'errors.invalidBody',
  });
export const invalidQuery = (): BadRequestException =>
  new BadRequestException({
    code: 'INVALID_QUERY',
    message: 'Invalid query',
    i18nKey: 'errors.invalidQuery',
  });
export const unknownTag = (): BadRequestException =>
  new BadRequestException({
    code: 'UNKNOWN_TAG',
    message: 'Unknown tag',
    i18nKey: 'errors.unknownTag',
  });
export const unknownField = (): BadRequestException =>
  new BadRequestException({
    code: 'UNKNOWN_FIELD',
    message: 'Unknown custom field',
    i18nKey: 'errors.unknownField',
  });
export const invalidValue = (): BadRequestException =>
  new BadRequestException({
    code: 'INVALID_VALUE',
    message: 'Invalid value',
    i18nKey: 'errors.invalidValue',
  });
export const conflict = (code: string): ConflictException =>
  new ConflictException({
    code,
    message: code,
    i18nKey: `errors.${code}`,
  });
