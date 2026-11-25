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
import { ConsolePlans } from './console-plans';

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    locale: 'en',
    t: (key: string) => key,
  }),
}));
vi.mock('@/lib/api', () => ({
  platformApi: vi.fn(),
  errorKey: () => 'errors.UNKNOWN',
}));
vi.mock('./console-shell', () => ({
  useConsole: () => ({ canWrite: false }),
}));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function plan(index: number): Plan {
  return {
    id: `plan-${index}`,
    code: `code-${index}`,
    name: `Plan ${index}`,
    priceMinor: index * 100,
    currency: 'UZS',
    periodDays: 30,
    limits: {},
    isActive: index % 2 === 0,
    isPublic: false,
    position: index,
    createdAt: `2026-11-${String((index % 20) + 1).padStart(2, '0')}T00:00:00Z`,
  };
}

function view(): void {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <ConsolePlans />
    </QueryClientProvider>,
  );
}

describe('ConsolePlans large lists', () => {
  it('renders 24 at first, then searches, filters and reveals more', async () => {
    vi.mocked(platformApi).mockImplementation((path: string) => {
      const params = new URL(path, 'http://local.test').searchParams;
      if (params.get('status') === 'active')
        return Promise.resolve({ plans: [], nextCursor: null });
      if (params.get('q') === 'code-999')
        return Promise.resolve({ plans: [plan(999)], nextCursor: null });
      if (params.get('cursor') === 'next')
        return Promise.resolve({ plans: [plan(24)], nextCursor: null });
      return Promise.resolve({
        plans: Array.from({ length: 24 }, (_, index) => plan(index)),
        nextCursor: 'next',
      });
    });
    view();
    expect(await screen.findAllByTestId('plan-row')).toHaveLength(24);
    fireEvent.click(screen.getByTestId('plans-more'));
    await waitFor(() =>
      expect(screen.getAllByTestId('plan-row')).toHaveLength(25),
    );
    expect(platformApi).toHaveBeenCalledWith(
      '/api/v1/platform/plans?q=&status=all&cursor=next',
    );

    fireEvent.change(screen.getByTestId('plan-search'), {
      target: { value: 'code-999' },
    });
    await waitFor(() =>
      expect(screen.getAllByTestId('plan-row')).toHaveLength(1),
    );
    expect(screen.getByTestId('plan-row')).toHaveTextContent('Plan 999');

    fireEvent.change(screen.getByTestId('plan-status'), {
      target: { value: 'active' },
    });
    expect(screen.queryAllByTestId('plan-row')).toHaveLength(0);
    expect(await screen.findByText('console.plans.emptyFiltered')).toBeTruthy();
    expect(platformApi).toHaveBeenLastCalledWith(
      '/api/v1/platform/plans?q=code-999&status=active',
    );
  });
});
