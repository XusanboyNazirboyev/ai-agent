import { describe, expect, it } from 'vitest';
import { parseTestAccountArgs, TEST_ACCOUNT_USAGE } from './test-account.js';

const ID = '0192f0c4-7a1e-7b3c-9d2e-4f5a6b7c8d9e';

describe('channel:test-account arguments', () => {
  it('accepts a tenant slug, an account uuid and on or off', () => {
    expect(parseTestAccountArgs(['dev-tenant', ID, 'on'])).toEqual({
      tenantSlug: 'dev-tenant',
      accountId: ID,
      on: true,
    });
    expect(
      parseTestAccountArgs(['dev-tenant', ID.toUpperCase(), 'off']),
    ).toEqual({ tenantSlug: 'dev-tenant', accountId: ID, on: false });
  });

  it.each([
    [[]],
    [['dev-tenant', ID]],
    [['dev-tenant', ID, 'yes']],
    [['dev-tenant', ID, 'ON']],
    [['dev-tenant', 'not-a-uuid', 'on']],
    [['Dev Tenant', ID, 'on']],
    [[ID, 'on']],
    [['dev-tenant', ID, 'on', '--force']],
  ])('refuses %j with the usage line', (argv) => {
    expect(() => parseTestAccountArgs(argv)).toThrow(TEST_ACCOUNT_USAGE);
  });
});
