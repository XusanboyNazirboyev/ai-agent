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
import type { Plan } from '@/lib/platform-types';
import { SubscriptionCard } from './tenant-billing';

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    locale: 'en',
    t: (key: string, values?: Record<string, unknown>) =>
      values?.name ? `${key}:${values.name}` : key,
  }),
}));
vi.mock('@/lib/api', () => ({
  platformApi: vi.fn(),
  errorKey: () => 'errors.UNKNOWN',
}));
vi.mock('./console-shell', () => ({ useConsole: () => ({ canWrite: true }) }));
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal(): void {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(): void {
    this.removeAttribute('open');
  };
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const plan: Plan = {
  id: 'plan-201',
  code: 'plan-201',
  name: 'Plan 201',
  priceMinor: 100,
  currency: 'UZS',
  periodDays: 30,
  limits: {},
  isActive: true,
  isPublic: false,
  position: 0,
  createdAt: '2026-11-20T00:00:00Z',
};

describe('SubscriptionCard', () => {
  it('starts a subscription with a plan from the search of every active plan', async () => {
    const api = vi.mocked(platformApi);
    api.mockImplementation((path: string) =>
      Promise.resolve(
        path.startsWith('/api/v1/platform/plans/available')
          ? { plans: [plan], nextCursor: null }
          : path.endsWith('/subscription')
            ? { current: null, history: [] }
            : {},
      ),
    );
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <SubscriptionCard tenantId="t1" />
      </QueryClientProvider>,
    );

    fireEvent.click(await screen.findByTestId('subscription-start'));
    // Nothing is chosen for the operator: the submit waits for a choice.
    expect(screen.getByTestId('subscription-submit')).toBeDisabled();
    const select = await screen.findByTestId('customer-plan');
    await screen.findByRole('option', { name: 'console.planOption:Plan 201' });
    fireEvent.change(select, { target: { value: 'plan-201' } });
    fireEvent.click(screen.getByTestId('subscription-submit'));

    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        '/api/v1/platform/tenants/t1/subscription',
        { method: 'POST', body: { planId: 'plan-201' } },
      ),
    );
    expect(api).not.toHaveBeenCalledWith('/api/v1/platform/plans');
  });
});
