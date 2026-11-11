import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import type { OwnSubscription, Role } from '@/lib/types';
import { SubscriptionPage } from './subscription-page';

let role: Role = 'OWNER';

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      key === 'subscription.pricePer'
        ? `${key}:${String(values?.price)}:${String(values?.days)}`
        : key,
    locale: 'en',
  }),
}));

vi.mock('./app-shell', () => ({
  useShell: () => ({ operator: { id: 'op', displayName: 'Op', role } }),
}));

vi.mock('@/lib/api', () => ({
  api: vi.fn(),
  errorKey: () => 'errors.UNKNOWN',
}));

vi.mock('@/lib/money', () => ({
  formatMoney: (minor: number, currency: string) => `${currency} ${minor}`,
  formatDate: (v: string) => `d:${v}`,
}));

vi.mock('./console/console-format', () => ({
  SubscriptionBadge: ({ status }: { status?: string }) => (
    <span data-testid="sub-badge">{status ?? 'none'}</span>
  ),
}));

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <SubscriptionPage />
    </QueryClientProvider>,
  );
}

const data: OwnSubscription = {
  access: { state: 'ok', periodEnd: null, graceUntil: null },
  subscription: {
    status: 'ACTIVE',
    planName: 'Pro',
    priceMinor: 1000,
    currency: 'USD',
    periodDays: 30,
    currentPeriodStart: '2026-11-01T00:00:00.000Z',
    currentPeriodEnd: '2026-12-01T00:00:00.000Z',
    graceUntil: null,
    canceledAt: null,
  },
  payments: [
    {
      id: 'p1',
      provider: 'CLICK',
      amountMinor: 1000,
      currency: 'USD',
      status: 'PAID',
      paidAt: '2026-11-01T00:00:00.000Z',
      createdAt: '2026-11-01T00:00:00.000Z',
    },
  ],
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  role = 'OWNER';
});

describe('SubscriptionPage', () => {
  it('hides data for non-manager roles', () => {
    role = 'OPERATOR';
    renderPage();
    expect(screen.getByText('team.managersOnly')).toBeInTheDocument();
    expect(api).not.toHaveBeenCalled();
  });

  it('renders current subscription, banner state and payments for manager', async () => {
    vi.mocked(api).mockResolvedValue(data);
    renderPage();
    expect(await screen.findByTestId('own-plan')).toHaveTextContent('Pro');
    expect(screen.getByTestId('own-status')).toBeInTheDocument();
    expect(screen.getByText('subscription.botOn')).toBeInTheDocument();
    expect(screen.getByText('USD 1000')).toBeInTheDocument();
    expect(screen.getByText('paymentStatus.PAID')).toBeInTheDocument();
  });

  it('renders no-subscription and expired states', async () => {
    vi.mocked(api).mockResolvedValue({
      access: {
        state: 'SUBSCRIPTION_EXPIRED',
        periodEnd: null,
        graceUntil: null,
      },
      subscription: null,
      payments: [],
    });
    renderPage();
    expect(await screen.findByTestId('own-none')).toHaveTextContent(
      'subscription.none',
    );
    expect(screen.getByText('banner.expired')).toBeInTheDocument();
  });
});
