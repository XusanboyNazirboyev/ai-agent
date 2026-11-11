import { describe, expect, it } from 'vitest';
import { parseResetMfaArgs } from './reset-platform-admin-mfa.js';

describe('reset platform admin MFA arguments', () => {
  it('parses and lowercases the email', () => {
    expect(parseResetMfaArgs(['--email', ' Owner@Example.TEST '])).toEqual({
      email: 'owner@example.test',
    });
  });

  it('refuses missing, valueless, unknown and malformed arguments', () => {
    expect(() => parseResetMfaArgs([])).toThrow(
      /--email is required[\s\S]*usage/u,
    );
    expect(() => parseResetMfaArgs(['--email'])).toThrow(/needs a value/u);
    expect(() => parseResetMfaArgs(['--email', '--x'])).toThrow(
      /needs a value/u,
    );
    expect(() => parseResetMfaArgs(['--name', 'x'])).toThrow(
      /unknown argument/u,
    );
    expect(() => parseResetMfaArgs(['--email', 'nope'])).toThrow(
      /not an email/u,
    );
  });
});
