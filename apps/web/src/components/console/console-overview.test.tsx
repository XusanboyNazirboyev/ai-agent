import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { platformApi } from '@/lib/api';
import type { PlatformOverview } from '@/lib/platform-types';
import { ConsoleOverview } from './console-overview';

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    locale: 'en',
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${JSON.stringify(values)}` : key,
    formatDateTime: () => 'when',
  }),
}));
vi.mock('@/lib/api', () => ({
  platformApi: vi.fn(),
  errorKey: () => 'errors.UNKNOWN',
}));

const month = (
  key: string,
  over: Partial<PlatformOverview['months'][number]>,
) => ({
  month: key,
  newCompanies: 0,
  trialsStarted: 0,
  convertedToPaid: 0,
  churned: 0,
  activeCompanies: 0,
  revenue: {},
  ...over,
});

const data: PlatformOverview = {
  timeZone: 'Asia/Tashkent',
  generatedAt: '2026-11-19T00:00:00Z',
  companies: {
    total: 9,
    byStatus: { ACTIVE: 8, SUSPENDED: 1, ARCHIVED: 0 },
    bySubscription: {
      TRIAL: 2,
      ACTIVE: 4,
      PAST_DUE: 1,
      EXPIRED: 1,
      CANCELED: 0,
      NONE: 1,
    },
  },
  trialsEndingSoon: 1,
  months: [
    month('2026-10', { newCompanies: 3, revenue: { UZS: '100000.00' } }),
    month('2026-11', {
      newCompanies: 2,
      churned: 1,
      activeCompanies: 5,
      revenue: { UZS: '250000.00', USD: '10.00' },
    }),
  ],
  revenue: {
    allTime: { UZS: '350000.00', USD: '10.00' },
    thisMonth: { UZS: '250000.00', USD: '10.00' },
    lastMonth: { UZS: '100000.00' },
    mrr: { UZS: '120000.00' },
  },
  usageThisMonth: { conversations: 12, inboundMessages: 340, llmCostUsd: 1.5 },
  recent: [
    {
      id: 'e1',
      kind: 'payment.recorded',
      tenantId: 'tid-1',
      tenantName: 'Acme School',
      at: '2026-11-18T10:00:00Z',
    },
  ],
};

function show(): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }): ReactNode => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  render(<ConsoleOverview />, { wrapper });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ConsoleOverview', () => {
  it('shows the tiles from the response', async () => {
    vi.mocked(platformApi).mockResolvedValue(data);
    show();
    expect(await screen.findByTestId('kpi-companies')).toHaveTextContent('9');
    expect(screen.getByTestId('kpi-paying')).toHaveTextContent('4');
    expect(screen.getByTestId('kpi-trial')).toHaveTextContent('2');
    expect(screen.getByTestId('kpi-trial-soon')).toHaveTextContent('1');
    expect(screen.getByTestId('kpi-churned')).toHaveTextContent('1');
    expect(screen.getByTestId('kpi-revenue')).toHaveTextContent(/250/u);
    expect(screen.getByTestId('kpi-mrr')).toHaveTextContent(/120/u);
    expect(screen.getByTestId('chart-companies')).toBeInTheDocument();
    expect(screen.getByTestId('chart-revenue')).toBeInTheDocument();
    expect(screen.getByTestId('overview-currency')).toBeInTheDocument();
  });

  it('links each state to the filtered customers list', async () => {
    vi.mocked(platformApi).mockResolvedValue(data);
    show();
    const trial = await screen.findByTestId('state-TRIAL');
    expect(trial).toHaveAttribute('href', '/console?subscription=TRIAL');
    expect(within(trial).getByText('2')).toBeInTheDocument();
    expect(screen.getByTestId('state-NONE')).toHaveAttribute(
      'href',
      '/console?subscription=NONE',
    );
  });

  it('links the company KPI tiles to their exact customer segments', async () => {
    vi.mocked(platformApi).mockResolvedValue(data);
    show();
    expect(await screen.findByTestId('kpi-companies')).toHaveAttribute(
      'href',
      '/console',
    );
    expect(screen.getByTestId('kpi-paying')).toHaveAttribute(
      'href',
      '/console?subscription=ACTIVE',
    );
    expect(screen.getByTestId('kpi-trial')).toHaveAttribute(
      'href',
      '/console?subscription=TRIAL',
    );
    expect(screen.getByTestId('kpi-trial-soon')).toHaveAttribute(
      'href',
      '/console?subscription=TRIAL_ENDING_SOON',
    );
    expect(screen.getByTestId('kpi-churned')).toHaveAttribute(
      'href',
      '/console?subscription=CHURNED_THIS_MONTH',
    );
  });

  it('lists recent events linking to the customer page', async () => {
    vi.mocked(platformApi).mockResolvedValue(data);
    show();
    const link = await screen.findByRole('link', { name: 'Acme School' });
    expect(link).toHaveAttribute('href', '/console/tenants/tid-1');
  });

  it('shows an empty state on a platform with no companies', async () => {
    vi.mocked(platformApi).mockResolvedValue({
      ...data,
      companies: {
        total: 0,
        byStatus: { ACTIVE: 0, SUSPENDED: 0, ARCHIVED: 0 },
        bySubscription: {
          TRIAL: 0,
          ACTIVE: 0,
          PAST_DUE: 0,
          EXPIRED: 0,
          CANCELED: 0,
          NONE: 0,
        },
      },
      months: [],
      recent: [],
    });
    show();
    expect(
      await screen.findByText('console.overview.empty'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('kpi-companies')).toBeNull();
  });
});
