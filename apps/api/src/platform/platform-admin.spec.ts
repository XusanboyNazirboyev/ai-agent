import { describe, expect, it } from 'vitest';
import { lastOwnerViolation } from './platform-admins.controller.js';
import { parsePlatformAdminArgs } from './platform-admin.js';
import {
  extendedPeriodEnd,
  monthStartUtc,
  nanoToUsd,
} from './subscription-math.js';

describe('platform admin CLI arguments', () => {
  it('parses, lowercases the email and defaults to PLATFORM_OWNER', () => {
    expect(
      parsePlatformAdminArgs([
        '--email',
        'Owner@Example.TEST',
        '--name',
        'Owner',
        '--password-file',
        '/tmp/x',
      ]),
    ).toEqual({
      email: 'owner@example.test',
      name: 'Owner',
      role: 'PLATFORM_OWNER',
      passwordFile: '/tmp/x',
    });
  });

  it('reports every problem and the usage', () => {
    expect(() => parsePlatformAdminArgs(['--email'])).toThrow(
      /--email needs a value.*--name is required.*--password-file is required[\s\S]*usage/u,
    );
    expect(() =>
      parsePlatformAdminArgs([
        '--email',
        'nope',
        '--name',
        'x',
        '--password-file',
        'f',
        '--role',
        'ROOT',
      ]),
    ).toThrow(/not an email address.*PLATFORM_OWNER or PLATFORM_SUPPORT/u);
    expect(() => parsePlatformAdminArgs(['--password', 'x'])).toThrow(
      /unknown argument --password/u,
    );
  });
});

describe('platform rules and subscription arithmetic', () => {
  it('never deactivates the last active PLATFORM_OWNER', () => {
    const owner = { role: 'PLATFORM_OWNER', isActive: true };
    expect(lastOwnerViolation(owner, 1)).toBe(true);
    expect(lastOwnerViolation(owner, 2)).toBe(false);
    expect(
      lastOwnerViolation({ role: 'PLATFORM_SUPPORT', isActive: true }, 1),
    ).toBe(false);
  });

  it('extends from the current end, never into the past', () => {
    const now = new Date('2026-11-15T00:00:00Z');
    expect(
      extendedPeriodEnd(
        new Date('2026-11-20T00:00:00Z'),
        30,
        now,
      ).toISOString(),
    ).toBe('2026-12-20T00:00:00.000Z');
    expect(
      extendedPeriodEnd(
        new Date('2026-11-13T00:00:00Z'),
        30,
        now,
      ).toISOString(),
    ).toBe('2026-12-13T00:00:00.000Z');
    expect(
      extendedPeriodEnd(
        new Date('2026-01-01T00:00:00Z'),
        30,
        now,
      ).toISOString(),
    ).toBe('2026-12-15T00:00:00.000Z');
  });

  it('counts usage from the first day of the UTC month', () => {
    expect(monthStartUtc(new Date('2026-11-30T23:59:00Z')).toISOString()).toBe(
      '2026-11-01T00:00:00.000Z',
    );
    expect(nanoToUsd(1_500_000_000n)).toBe(1.5);
    expect(nanoToUsd(null)).toBe(0);
  });
});
