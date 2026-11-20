import { useState, type ReactNode } from 'react';
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
import type { Plan } from '@/lib/platform-types';
import { CustomerPlanPicker } from './customer-plan-picker';

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    locale: 'en',
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${values.name}` : key,
  }),
}));
vi.mock('@/lib/api', () => ({
  platformApi: vi.fn(),
  errorKey: () => 'errors.UNKNOWN',
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const newest: Plan = {
  id: 'newest',
  code: 'newest',
  name: 'Newest plan',
  priceMinor: 100,
  currency: 'UZS',
  periodDays: 30,
  limits: {},
  isActive: true,
  isPublic: false,
  position: 0,
  createdAt: '2026-11-20T00:00:00Z',
};
const older = { ...newest, id: 'older', code: 'older', name: 'Older plan' };

function Harness(): ReactNode {
  const [value, setValue] = useState<Plan | null>(null);
  return <CustomerPlanPicker value={value} onChange={setValue} />;
}
function show(): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  );
}
function search(value: string): void {
  fireEvent.change(screen.getByTestId('customer-plan-search'), {
    target: { value },
  });
}
function select(value: string): void {
  fireEvent.change(screen.getByTestId('customer-plan'), { target: { value } });
}

describe('CustomerPlanPicker', () => {
  it('loads older choices from the cursor and preserves a selection across searches', async () => {
    vi.mocked(platformApi).mockImplementation((path: string) => {
      const q = new URL(path, 'http://local.test').searchParams;
      if (q.get('q') === 'nothing')
        return Promise.resolve({ plans: [], nextCursor: null });
      if (q.has('cursor'))
        return Promise.resolve({ plans: [older], nextCursor: null });
      return Promise.resolve({ plans: [newest], nextCursor: 'next-page' });
    });
    show();
    await screen.findByRole('option', { name: /Newest plan/u });
    fireEvent.click(screen.getByTestId('customer-plans-more'));
    await screen.findByRole('option', { name: /Older plan/u });
    expect(platformApi).toHaveBeenCalledWith(
      expect.stringContaining('cursor=next-page'),
    );
    expect(screen.queryByTestId('customer-plans-more')).toBeNull();
    select('older');
    search('nothing');
    await screen.findByText('console.newCustomer.noMatchingPlans');
    expect(screen.getByTestId('customer-plan')).toHaveValue('older');
    expect(screen.getByRole('option', { name: /Older plan/u })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /Newest plan/u })).toBeNull();
    expect(platformApi).toHaveBeenLastCalledWith(
      '/api/v1/platform/plans/available?q=nothing&limit=25',
    );
    select('');
    expect(screen.getByTestId('customer-plan')).toHaveValue('');
  });

  it('debounces rapid typing and encodes the search without reusing an old cursor', async () => {
    vi.mocked(platformApi).mockResolvedValue({
      plans: [newest],
      nextCursor: null,
    });
    show();
    await screen.findByRole('option', { name: /Newest plan/u });
    search('a');
    search('a&');
    search('a&b');
    await waitFor(() => expect(platformApi).toHaveBeenCalledTimes(2));
    expect(platformApi).toHaveBeenLastCalledWith(
      '/api/v1/platform/plans/available?q=a%26b&limit=25',
    );
  });

  it('shows loading and retries a first-page error instead of claiming there are no matches', async () => {
    let reject!: (error: Error) => void;
    vi.mocked(platformApi).mockImplementationOnce(
      () =>
        new Promise((_resolve, no) => {
          reject = no;
        }),
    );
    show();
    expect(screen.getByRole('status')).toHaveTextContent('app.loading');
    reject(new Error('offline'));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'errors.UNKNOWN',
    );
    expect(
      screen.queryByText('console.newCustomer.noMatchingPlans'),
    ).toBeNull();
    vi.mocked(platformApi).mockResolvedValue({
      plans: [newest],
      nextCursor: null,
    });
    fireEvent.click(screen.getByRole('button', { name: 'app.retry' }));
    expect(
      await screen.findByRole('option', { name: /Newest plan/u }),
    ).toBeTruthy();
  });

  it('retries the failed next page without losing loaded choices or the selection', async () => {
    vi.mocked(platformApi)
      .mockResolvedValueOnce({ plans: [newest], nextCursor: 'next-page' })
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ plans: [older], nextCursor: null });
    show();
    await screen.findByRole('option', { name: /Newest plan/u });
    select('newest');
    fireEvent.click(screen.getByTestId('customer-plans-more'));
    await screen.findByRole('alert');
    expect(screen.getByTestId('customer-plan')).toHaveValue('newest');
    fireEvent.click(screen.getByRole('button', { name: 'app.retry' }));
    await screen.findByRole('option', { name: /Older plan/u });
    expect(screen.getByTestId('customer-plan')).toHaveValue('newest');
    expect(platformApi).toHaveBeenLastCalledWith(
      expect.stringContaining('cursor=next-page'),
    );
  });
});
