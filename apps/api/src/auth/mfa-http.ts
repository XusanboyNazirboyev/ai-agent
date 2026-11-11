import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { z } from 'zod';
import { MfaError, type MfaErrorCode } from './mfa.service.js';

const MESSAGES: Record<MfaErrorCode, string> = {
  MFA_NOT_AVAILABLE: 'Two-factor authentication is not available',
  MFA_ALREADY_ENABLED: 'Two-factor authentication is already on',
  MFA_SETUP_REQUIRED: 'Start the setup first',
  MFA_NOT_ENABLED: 'Two-factor authentication is not on',
  MFA_INVALID_CODE: 'The code is not valid',
  MFA_CHALLENGE_INVALID: 'The sign-in step expired, sign in again',
  MFA_REQUIRED_BY_POLICY: 'Two-factor authentication is required here',
  INVALID_CREDENTIALS: 'Invalid email or password',
  LOCKED: 'Invalid email or password',
};

/**
 * Maps an MFA failure to an HTTP error. `signingIn` endpoints answer 401 for
 * a bad code (the form shows it); endpoints behind a session use 400 so the
 * web client does not mistake it for an expired session.
 */
export function mfaHttpError(error: unknown, signingIn: boolean): unknown {
  if (!(error instanceof MfaError)) return error;
  const body = {
    code: error.code,
    message: MESSAGES[error.code],
    i18nKey:
      error.code === 'LOCKED' ? 'errors.accountLocked' : `errors.${error.code}`,
  };
  switch (error.code) {
    case 'MFA_NOT_AVAILABLE':
      return new ServiceUnavailableException(body);
    case 'MFA_ALREADY_ENABLED':
    case 'MFA_SETUP_REQUIRED':
    case 'MFA_NOT_ENABLED':
      return new ConflictException(body);
    case 'MFA_REQUIRED_BY_POLICY':
      return new ForbiddenException(body);
    case 'MFA_CHALLENGE_INVALID':
    case 'LOCKED':
      return new UnauthorizedException(body);
    default:
      return signingIn
        ? new UnauthorizedException(body)
        : new BadRequestException(body);
  }
}

const CODE = z.string().trim().min(1).max(32);

export const ChallengeBody = z.object({
  challenge: z.string().min(1).max(200),
});
export const SecondFactorBody = z
  .object({ code: CODE.optional(), recoveryCode: CODE.optional() })
  .refine((v) => (v.code === undefined) !== (v.recoveryCode === undefined));
export const LoginMfaBody = ChallengeBody.extend({
  code: CODE.optional(),
  recoveryCode: CODE.optional(),
}).refine((v) => (v.code === undefined) !== (v.recoveryCode === undefined));
export const CodeBody = z.object({ code: CODE });
export const EnrollEnableBody = ChallengeBody.extend({ code: CODE });
export const DisableBody = z
  .object({
    password: z.string().min(1).max(200),
    code: CODE.optional(),
    recoveryCode: CODE.optional(),
  })
  .refine((v) => (v.code === undefined) !== (v.recoveryCode === undefined));

export function parseMfaBody<T extends z.ZodType>(
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
