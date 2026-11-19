import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import type { OwnSubscription } from '@/lib/types';
import { SubscriptionPay } from './subscription-pay';

vi.mock('@/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key, locale: 'en' }),
}));
vi.mock('@/lib/api', () => ({
  api: vi.fn(),
  errorKey: () => 'errors.UNKNOWN',
}));

afterEach(() => {
  cleanup();
  vi.mocked(api).mockReset();
  vi.useRealTimers();
  window.history.replaceState(null, '', '/');
});

const BASE: OwnSubscription = {
  access: { state: 'ok', periodEnd: null, graceUntil: null },
  subscription: null,
  clickConfigured: true,
  currentPlanCode: 'pro',
  plans: [
    {
      code: 'basic',
      name: 'Basic',
      priceMinor: 5000000,
      currency: 'UZS',
      periodDays: 30,
    },
    {
      code: 'pro',
      name: 'Pro',
      priceMinor: 15000000,
      currency: 'UZS',
      periodDays: 30,
    },
    {
      code: 'usd',
      name: 'Dollar',
      priceMinor: 1000,
      currency: 'USD',
      periodDays: 30,
    },
  ],
  payments: [],
};

function renderIt(
  data: OwnSubscription,
  navigate = vi.fn(),
  refetch = vi.fn(),
): void {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <SubscriptionPay data={data} refetch={refetch} navigate={navigate} />
    </QueryClientProvider>,
  );
}

describe('SubscriptionPay', () => {
  it('lists UZS plans, preselects the current one and posts the checkout', async () => {
    vi.mocked(api).mockResolvedValue({ url: 'https://my.click.uz/x' });
    const navigate = vi.fn();
    renderIt(BASE, navigate);
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    expect((screen.getByDisplayValue('pro') as HTMLInputElement).checked).toBe(
      true,
    );
    fireEvent.click(screen.getByDisplayValue('basic'));
    fireEvent.click(screen.getByTestId('pay-click'));
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith('https://my.click.uz/x'),
    );
    expect(api).toHaveBeenCalledWith('/api/v1/billing/click/checkout', {
      method: 'POST',
      body: { planCode: 'basic' },
    });
  });

  it('hides the button with an explanation when Click is not configured', () => {
    renderIt({ ...BASE, clickConfigured: false });
    expect(screen.queryByTestId('pay-click')).toBeNull();
    expect(screen.getByTestId('pay-unavailable')).toBeTruthy();
  });

  it('after return shows the confirming notice and refetches', () => {
    vi.useFakeTimers();
    window.history.replaceState(null, '', '/settings/subscription?paid=1');
    const refetch = vi.fn();
    renderIt(BASE, vi.fn(), refetch);
    expect(screen.getByTestId('pay-notice').textContent).toBe(
      'billing.confirming',
    );
    act(() => {
      vi.advanceTimersByTime(3_100);
    });
    expect(refetch).toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByTestId('pay-notice').textContent).toBe(
      'billing.stillWaiting',
    );
  });
});
