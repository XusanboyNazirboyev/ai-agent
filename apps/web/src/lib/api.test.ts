import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, errorKey, platformApi } from './api';

function clearCookies(): void {
  for (const part of document.cookie.split(';')) {
    const name = part.split('=')[0]?.trim();
    if (name)
      document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
  }
}

describe('api helpers and the two CSRF cookies (ADR 047 §1)', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    clearCookies();
    document.cookie = 'ac_csrf=tenant-csrf; path=/';
    document.cookie = 'ac_platform_csrf=platform-csrf; path=/';
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    clearCookies();
  });

  function sentHeaders(): Record<string, string> {
    const init = fetchMock.mock.calls[0]?.[1] as {
      headers: Record<string, string>;
    };
    return init.headers;
  }

  it('tenant calls echo only the tenant CSRF cookie on writes', async () => {
    await api('/api/v1/team/invites', { method: 'POST', body: {} });
    expect(sentHeaders()['x-csrf-token']).toBe('tenant-csrf');
  });

  it('platform calls echo only the platform CSRF cookie on writes', async () => {
    await platformApi('/api/v1/platform/plans', { method: 'POST', body: {} });
    expect(sentHeaders()['x-csrf-token']).toBe('platform-csrf');
  });

  it('reads send no CSRF header', async () => {
    await platformApi('/api/v1/platform/tenants');
    expect(sentHeaders()['x-csrf-token']).toBeUndefined();
  });

  it('a missing platform cookie never falls back to the tenant one', async () => {
    document.cookie =
      'ac_platform_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
    await platformApi('/api/v1/platform/plans', { method: 'POST', body: {} });
    expect(sentHeaders()['x-csrf-token']).toBeUndefined();
  });

  it('keeps the API i18n key of a refusal', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          code: 'LAST_OWNER',
          i18nKey: 'team.errors.LAST_OWNER',
        }),
        { status: 403 },
      ),
    );
    const error = await api('/api/v1/team/operators/x', {
      method: 'PATCH',
      body: {},
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).i18nKey).toBe('team.errors.LAST_OWNER');
  });
});

describe('errorKey', () => {
  it('prefers the API key when the catalog has it', () => {
    expect(
      errorKey(new ApiError(403, 'TENANT_SUSPENDED', 'errors.tenantSuspended')),
    ).toBe('errors.tenantSuspended');
    expect(
      errorKey(
        new ApiError(409, 'SEATS_EXHAUSTED', 'team.errors.SEATS_EXHAUSTED'),
      ),
    ).toBe('team.errors.SEATS_EXHAUSTED');
  });

  it('falls back to the code message for keys the catalog lacks', () => {
    expect(errorKey(new ApiError(403, 'FORBIDDEN', 'errors.forbidden'))).toBe(
      'errors.FORBIDDEN',
    );
    expect(errorKey(new Error('x'))).toBe('errors.UNKNOWN');
  });
});
