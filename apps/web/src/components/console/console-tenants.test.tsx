import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { platformApi } from '@/lib/api';
import { ConsoleTenants } from './console-tenants';

let canWrite = true;

vi.mock('@/i18n', () => ({
  useI18n: () => ({ t: (k: string) => k, locale: 'en' }),
}));

vi.mock('./console-shell', () => ({
  useConsole: () => ({ canWrite }),
}));

vi.mock('@/lib/api', () => ({
  platformApi: vi.fn(),
}));

vi.mock('@/lib/money', () => ({
  formatDate: () => 'd',
  formatUsd: () => '$1',
}));

vi.mock('./new-customer-dialog', () => ({
  NewCustomerDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="new-customer-dialog" /> : null,
}));

vi.mock('./console-format', () => ({
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
  SubscriptionBadge: ({ status }: { status?: string }) => (
    <span>{status ?? 'none'}</span>
  ),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  canWrite = true;
});

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ConsoleTenants />
    </QueryClientProvider>,
  );
}

const tenants = [
  {
    id: 't1',
    slug: 'acme',
    name: 'Acme',
    status: 'ACTIVE',
    subscription: { planName: 'Pro', currentPeriodEnd: 'x', status: 'ACTIVE' },
    usage: { conversations: 1, inboundMessages: 2, llmCostUsd: 0 },
  },
];

describe('ConsoleTenants', () => {
  it('renders tenants and hides create for read-only', async () => {
    canWrite = false;
    vi.mocked(platformApi).mockResolvedValue({ tenants });
    renderPage();
    expect(await screen.findByTestId('tenant-row')).toBeInTheDocument();
    expect(screen.queryByTestId('new-customer')).not.toBeInTheDocument();
  });

  it('allows writable user to open new customer dialog', async () => {
    vi.mocked(platformApi).mockResolvedValue({ tenants });
    renderPage();
    expect(await screen.findByTestId('new-customer')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('new-customer'));
    expect(screen.getByTestId('new-customer-dialog')).toBeInTheDocument();
  });

  it('applies status filter in query', async () => {
    vi.mocked(platformApi).mockResolvedValue({ tenants: [] });
    renderPage();
    await waitFor(() => expect(platformApi).toHaveBeenCalled());
    fireEvent.change(screen.getByTestId('tenant-status-filter'), {
      target: { value: 'SUSPENDED' },
    });
    await waitFor(() =>
      expect(platformApi).toHaveBeenLastCalledWith(
        '/api/v1/platform/tenants?status=SUSPENDED',
      ),
    );
  });
});
