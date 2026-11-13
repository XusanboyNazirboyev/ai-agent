import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';

/** HTTP error bodies of the pipelines and opportunity API (ADR 057). */
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
export const invalidValue = (): BadRequestException =>
  new BadRequestException({
    code: 'INVALID_VALUE',
    message: 'Invalid value',
    i18nKey: 'errors.invalidValue',
  });
export const unknownOperator = (): BadRequestException =>
  new BadRequestException({
    code: 'UNKNOWN_OPERATOR',
    message: 'Unknown operator',
    i18nKey: 'errors.UNKNOWN_OPERATOR',
  });
export const lostReasonRequired = (): BadRequestException =>
  new BadRequestException({
    code: 'LOST_REASON_REQUIRED',
    message: 'A lost reason is required',
    i18nKey: 'errors.LOST_REASON_REQUIRED',
  });
export const conflict = (
  code:
    | 'PIPELINE_LIMIT'
    | 'PIPELINE_HAS_LEADS'
    | 'PIPELINE_IS_DEFAULT'
    | 'STAGE_HAS_LEADS'
    | 'STAGE_IS_DEFAULT'
    | 'STAGE_LAST_OPEN'
    | 'LEAD_STAGE_LIMIT'
    | 'LEAD_ARCHIVED'
    | 'LEAD_NOT_ARCHIVED',
  message: string,
  extra: Record<string, number> = {},
): ConflictException =>
  new ConflictException({
    code,
    message,
    i18nKey: `errors.${code}`,
    ...extra,
  });
export const stageNotOpen = (): BadRequestException =>
  new BadRequestException({
    code: 'STAGE_NOT_OPEN',
    message: 'A lead is created in an open stage',
    i18nKey: 'errors.STAGE_NOT_OPEN',
  });
