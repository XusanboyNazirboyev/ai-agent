import { DEFAULT_SCRYPT, type ScryptParams } from '../webinbox/password.js';

export interface SessionPolicy {
  readonly absoluteTtlMs: number;
  readonly idleTtlMs: number;
  readonly maxFailedAttempts: number;
  readonly lockMs: number;
  readonly scrypt: ScryptParams;
}

export const SESSION_POLICY = Symbol('SESSION_POLICY');

export const DEFAULT_SESSION_POLICY: SessionPolicy = {
  absoluteTtlMs: 12 * 60 * 60 * 1000,
  idleTtlMs: 2 * 60 * 60 * 1000,
  maxFailedAttempts: 5,
  lockMs: 15 * 60 * 1000,
  scrypt: DEFAULT_SCRYPT,
};
