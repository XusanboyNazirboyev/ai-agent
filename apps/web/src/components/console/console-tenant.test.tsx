import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { platformApi } from '@/lib/api';
import { ConsoleTenant } from './console-tenant';

let canWrite = true;

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 't1' }),
}));

vi.mock('@/i18n', () => ({
  useI18n: () => ({ t: (k: string) => k, locale: 'en' }),
}));

vi.mock('./console-shell', () => ({
  useConsole: () => ({ canWrite }),
}));

vi.mock('@/lib/api', () => ({
  platformApi: vi.fn(),
  errorKey: () => 'errors.UNKNOWN',
}));

vi.mock('@/lib/money', () => ({
  formatDate: () => 'd',
  formatUsd: () => '$1',
}));

vi.mock('./console-format', () => ({
  Card: ({
    title,
    actions,
    children,
    testId,
  }: {
    title: string;
    actions?: React.ReactNode;
    children: React.ReactNode;
    testId?: string;
  }) => (
    <section data-testid={testId}>
      <h2>{title}</h2>
      <div>{actions}</div>
      {children}
    </section>
  ),
  Field: ({
    label,
    children,
  }: {
    label: string;
    children: React.ReactNode;
  }) => (
    <div>
      {label}:{children}
    </div>
  ),
  TenantStatusBadge: ({ status }: { status: string }) => <span>{status}</span>,
}));

vi.mock('./tenant-billing', () => ({
  SubscriptionCard: () => <div data-testid="sub-card" />,
  PaymentsCard: () => <div data-testid="pay-card" />,
}));

vi.mock('./new-customer-dialog', () => ({
  useLocaleName: () => (id: string) => id,
}));

vi.mock('../invite-link-box', () => ({
  InviteLinkBox: () => <div data-testid="invite-link" />,
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
  canWrite = true;
});

function renderTenant() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ConsoleTenant />
    </QueryClientProvider>,
  );
}

const detail = {
  tenant: {
    id: 't1',
    slug: 'acme',
    name: 'Acme',
    status: 'ACTIVE',
    packKey: 'p',
    packVersion: '1',
    defaultLocale: 'en',
    timezone: 'UTC',
    createdAt: 't',
  },
  access: { state: 'ok' },
  channels: [],
  subscription: null,
  usage: { conversations: 0, inboundMessages: 0, llmCostUsd: 0 },
  operators: [],
  invites: [],
};

describe('ConsoleTenant', () => {
  it('hides status actions for read-only users', async () => {
    canWrite = false;
    vi.mocked(platformApi).mockResolvedValue(detail);
    renderTenant();
    expect(await screen.findByTestId('tenant-detail')).toBeInTheDocument();
    expect(screen.queryByTestId('tenant-suspend')).not.toBeInTheDocument();
  });

  it('suspend requires reason dialog and calls API only after confirm', async () => {
    vi.mocked(platformApi).mockImplementation(
      (path: string, options?: { method?: string }) => {
        if (path === '/api/v1/platform/tenants/t1' && !options?.method)
          return Promise.resolve(detail);
        if (
          path === '/api/v1/platform/tenants/t1' &&
          options?.method === 'PATCH'
        )
          return Promise.resolve({});
        return Promise.reject(new Error(path));
      },
    );
    renderTenant();
    fireEvent.click(await screen.findByTestId('tenant-suspend'));
    expect(screen.getByTestId('status-dialog')).toBeVisible();
    expect(platformApi).not.toHaveBeenCalledWith(
      '/api/v1/platform/tenants/t1',
      expect.objectContaining({ method: 'PATCH' }),
    );
    fireEvent.change(screen.getByTestId('reason-input'), {
      target: { value: 'policy' },
    });
    fireEvent.click(screen.getByTestId('reason-confirm'));
    await waitFor(() =>
      expect(platformApi).toHaveBeenCalledWith('/api/v1/platform/tenants/t1', {
        method: 'PATCH',
        body: { status: 'SUSPENDED', reason: 'policy' },
      }),
    );
  });

  it('shows reactivate for suspended tenant', async () => {
    vi.mocked(platformApi).mockResolvedValue({
      ...detail,
      tenant: { ...detail.tenant, status: 'SUSPENDED' },
    });
    renderTenant();
    expect(await screen.findByTestId('tenant-reactivate')).toBeInTheDocument();
  });
});
