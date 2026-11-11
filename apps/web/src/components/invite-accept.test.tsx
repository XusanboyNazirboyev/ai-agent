import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, platformApi } from '@/lib/api';
import { InviteAccept } from './invite-accept';

const replace = vi.fn();
let token: string | string[] = 'tok-1';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace }),
  useParams: () => ({ token }),
}));

vi.mock('@/i18n', () => ({
  LOCALES: ['en', 'uz-Latn', 'ru'],
  useI18n: () => ({
    locale: 'en',
    setLocale: vi.fn(),
    t: (key: string, values?: Record<string, unknown>) =>
      key === 'invite.accept.tooShort' || key === 'invite.accept.passwordHint'
        ? `${key}:${String(values?.min ?? '')}`
        : key,
  }),
}));

vi.mock('@/lib/api', () => {
  class MockApiError extends Error {
    constructor(
      readonly status: number,
      readonly code: string,
      readonly i18nKey?: string,
    ) {
      super(code);
    }
  }
  return {
    api: vi.fn(),
    platformApi: vi.fn(),
    ApiError: MockApiError,
    errorKey: (e: unknown) =>
      e instanceof MockApiError ? e.code : 'errors.UNKNOWN',
  };
});

function renderAccept(kind: 'tenant' | 'platform') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <InviteAccept kind={kind} />
    </QueryClientProvider>,
  );
}

function fill(password: string, repeat = password, name = 'Ada') {
  fireEvent.change(screen.getByTestId('invite-name'), {
    target: { value: name },
  });
  fireEvent.change(screen.getByTestId('invite-password'), {
    target: { value: password },
  });
  fireEvent.change(screen.getByTestId('invite-repeat'), {
    target: { value: repeat },
  });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  token = 'tok-1';
});

describe('InviteAccept', () => {
  beforeEach(() => {
    vi.mocked(api).mockResolvedValue({
      email: 'a@b.c',
      role: 'ADMIN',
      tenantName: 'Acme',
      expiresAt: '2026-11-20T00:00:00.000Z',
    });
    vi.mocked(platformApi).mockResolvedValue({});
  });

  it('validates name, password length and mismatch before calling API', async () => {
    renderAccept('tenant');
    await screen.findByTestId('invite-accept');

    fireEvent.change(screen.getByTestId('invite-name'), {
      target: { value: '   ' },
    });
    fireEvent.change(screen.getByTestId('invite-password'), {
      target: { value: 'longenough1' },
    });
    fireEvent.change(screen.getByTestId('invite-repeat'), {
      target: { value: 'longenough1' },
    });
    fireEvent.submit(screen.getByTestId('invite-accept'));
    expect(await screen.findByTestId('invite-error')).toHaveTextContent(
      'invite.accept.nameRequired',
    );
    expect(api).not.toHaveBeenCalledWith(
      expect.stringContaining('/accept'),
      expect.anything(),
    );

    cleanup();
    renderAccept('tenant');
    await screen.findByTestId('invite-accept');
    fill('short');
    fireEvent.submit(screen.getByTestId('invite-accept'));
    expect(await screen.findByTestId('invite-error')).toHaveTextContent(
      'invite.accept.tooShort:10',
    );

    cleanup();
    renderAccept('tenant');
    await screen.findByTestId('invite-accept');
    fill('longenough1', 'different1');
    fireEvent.submit(screen.getByTestId('invite-accept'));
    expect(await screen.findByTestId('invite-error')).toHaveTextContent(
      'invite.accept.mismatch',
    );
  });

  it('shows invalid invite state for 404 preview and submits tenant invite', async () => {
    vi.mocked(api).mockImplementation(
      (path: string, options?: { method?: string }) => {
        if (path.includes('/invites/tok-1') && !options?.method) {
          return Promise.reject(new ApiError(404, 'NOT_FOUND'));
        }
        if (path.includes('/accept') && options?.method === 'POST') {
          return Promise.resolve({});
        }
        return Promise.reject(new Error(`unexpected ${path}`));
      },
    );
    renderAccept('tenant');
    expect(await screen.findByTestId('invite-invalid')).toBeInTheDocument();

    cleanup();
    vi.mocked(api).mockImplementation(
      (path: string, options?: { method?: string }) => {
        if (path.includes('/invites/tok-1') && !options?.method) {
          return Promise.resolve({
            email: 'a@b.c',
            role: 'ADMIN',
            tenantName: 'Acme',
            expiresAt: 'x',
          });
        }
        if (
          path.includes('/invites/tok-1/accept') &&
          options?.method === 'POST'
        ) {
          return Promise.resolve({});
        }
        return Promise.reject(new Error(`unexpected ${path}`));
      },
    );
    renderAccept('tenant');
    await screen.findByTestId('invite-accept');
    fill('longenough1', 'longenough1', 'Ada');
    fireEvent.submit(screen.getByTestId('invite-accept'));
    await waitFor(() => {
      expect(api).toHaveBeenCalledWith('/api/v1/auth/invites/tok-1/accept', {
        method: 'POST',
        body: { displayName: 'Ada', password: 'longenough1' },
      });
      expect(replace).toHaveBeenCalledWith('/inbox');
    });
  });

  it('enforces platform password length and submits via platformApi', async () => {
    renderAccept('platform');
    fill('longenough1', 'longenough1', '');
    fireEvent.submit(screen.getByTestId('invite-accept'));
    expect(await screen.findByTestId('invite-error')).toHaveTextContent(
      'invite.accept.tooShort:12',
    );

    cleanup();
    renderAccept('platform');
    fill('longenough12', 'longenough12', '');
    fireEvent.submit(screen.getByTestId('invite-accept'));
    await waitFor(() => {
      expect(platformApi).toHaveBeenCalledWith(
        '/api/v1/platform/auth/invites/tok-1/accept',
        {
          method: 'POST',
          body: { password: 'longenough12' },
        },
      );
      expect(replace).toHaveBeenCalledWith('/console/login');
    });
  });

  it('maps API errors and keeps form when accept fails', async () => {
    vi.mocked(api).mockImplementation(
      (path: string, options?: { method?: string }) => {
        if (path.includes('/invites/tok-1') && !options?.method) {
          return Promise.resolve({
            email: 'a@b.c',
            role: 'ADMIN',
            tenantName: 'Acme',
            expiresAt: 'x',
          });
        }
        if (path.includes('/accept'))
          return Promise.reject(new ApiError(400, 'INVITE_EXPIRED'));
        return Promise.reject(new Error(`unexpected ${path}`));
      },
    );
    renderAccept('tenant');
    await screen.findByTestId('invite-accept');
    fill('longenough1');
    fireEvent.submit(screen.getByTestId('invite-accept'));
    expect(await screen.findByTestId('invite-error')).toHaveTextContent(
      'INVITE_EXPIRED',
    );
    expect(replace).not.toHaveBeenCalled();
  });
});
