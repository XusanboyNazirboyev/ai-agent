import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ApiError, platformApi } from '@/lib/api';
import { NewCustomerDialog, slugify } from './new-customer-dialog';

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (k: string) => k,
    locale: 'en',
  }),
}));

vi.mock('@/lib/api', () => {
  class MockApiError extends Error {
    constructor(
      readonly status: number,
      readonly code: string,
    ) {
      super(code);
    }
  }
  return {
    platformApi: vi.fn(),
    ApiError: MockApiError,
    errorKey: (e: unknown) =>
      e instanceof MockApiError ? `errors.${e.code}` : 'errors.UNKNOWN',
  };
});

vi.mock('@/lib/money', () => ({
  formatMoney: (minor: number, currency: string) => `${currency} ${minor}`,
}));

vi.mock('../invite-link-box', () => ({
  InviteLinkBox: ({ path, email }: { path: string; email: string }) => (
    <div data-testid="invite-link">
      {path}|{email}
    </div>
  ),
}));

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close() {
    this.open = false;
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderDialog(open = true) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <NewCustomerDialog open={open} onClose={onClose} />
    </QueryClientProvider>,
  );
  return { onClose };
}

describe('new-customer-dialog', () => {
  it('slugify normalizes names', () => {
    expect(slugify('Acme Co!')).toBe('acme-co');
  });

  it('validates required fields before submit', async () => {
    vi.mocked(platformApi).mockImplementation((path: string) => {
      if (path.includes('/tenants/options'))
        return Promise.resolve({ packs: ['default'], locales: ['en'] });
      if (path.includes('/plans')) return Promise.resolve({ plans: [] });
      return Promise.reject(new Error(path));
    });
    renderDialog();
    await waitFor(() => expect(platformApi).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('new-customer-submit'));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'console.formInvalid',
    );
    expect(platformApi).not.toHaveBeenCalledWith(
      '/api/v1/platform/tenants',
      expect.anything(),
    );
  });

  it('creates tenant and shows invite link, maps API error', async () => {
    vi.mocked(platformApi).mockImplementation(
      (path: string, options?: { method?: string }) => {
        if (path.includes('/tenants/options'))
          return Promise.resolve({ packs: ['default'], locales: ['en'] });
        if (path.includes('/plans')) return Promise.resolve({ plans: [] });
        if (path === '/api/v1/platform/tenants' && options?.method === 'POST')
          return Promise.resolve({
            tenant: { id: 't1', slug: 'acme', name: 'Acme' },
            invite: {
              id: 'i1',
              email: 'o@x.io',
              role: 'OWNER',
              expiresAt: 'x',
              path: '/invite/tok',
            },
          });
        return Promise.reject(new Error(`unexpected ${path}`));
      },
    );
    renderDialog();
    await waitFor(() =>
      expect(screen.getByTestId('customer-pack')).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByTestId('customer-name'), {
      target: { value: 'Acme' },
    });
    fireEvent.change(screen.getByTestId('customer-email'), {
      target: { value: 'o@x.io' },
    });
    fireEvent.click(screen.getByTestId('new-customer-submit'));
    expect(await screen.findByTestId('invite-link')).toHaveTextContent(
      '/invite/tok|o@x.io',
    );

    cleanup();
    vi.mocked(platformApi).mockImplementation(
      (path: string, options?: { method?: string }) => {
        if (path.includes('/tenants/options'))
          return Promise.resolve({ packs: ['default'], locales: ['en'] });
        if (path.includes('/plans')) return Promise.resolve({ plans: [] });
        if (path === '/api/v1/platform/tenants' && options?.method === 'POST')
          return Promise.reject(new ApiError(400, 'SLUG_TAKEN'));
        return Promise.reject(new Error(`unexpected ${path}`));
      },
    );
    renderDialog();
    await waitFor(() =>
      expect(screen.getByTestId('customer-pack')).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByTestId('customer-name'), {
      target: { value: 'Acme' },
    });
    fireEvent.change(screen.getByTestId('customer-email'), {
      target: { value: 'o@x.io' },
    });
    fireEvent.click(screen.getByTestId('new-customer-submit'));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'errors.SLUG_TAKEN',
    );
  });
});
