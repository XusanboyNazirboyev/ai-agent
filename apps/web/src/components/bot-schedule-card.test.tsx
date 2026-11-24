import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { BotScheduleCard, scheduleProblem } from './bot-schedule-card';

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('./ui/toast', () => ({ useToast: () => vi.fn() }));
vi.mock('@/lib/api', () => ({
  api: vi.fn(),
  errorKey: () => 'errors.UNKNOWN',
}));

function view(node: ReactNode): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

afterEach(() => {
  cleanup();
  vi.mocked(api).mockReset();
});

const always = {
  mode: 'always' as const,
  days: [1, 2, 3, 4, 5, 6],
  from: '09:00',
  to: '18:00',
};

describe('bot schedule card (ADR 089)', () => {
  it('flags what the API would refuse', () => {
    expect(scheduleProblem(always)).toBeNull();
    expect(scheduleProblem({ ...always, mode: 'off_hours', days: [] })).toBe(
      'agent.schedule.noDays',
    );
    expect(
      scheduleProblem({ ...always, mode: 'work_hours', to: '09:00' }),
    ).toBe('agent.schedule.sameTime');
  });

  it('shows days and times only for a timed mode and saves the choice', async () => {
    vi.mocked(api).mockImplementation(async (_path, init) =>
      init?.method === 'PUT' ? (init.body as never) : (always as never),
    );
    view(<BotScheduleCard canChange />);
    const mode = await screen.findByTestId('bot-schedule-mode');
    expect(screen.queryByTestId('bot-schedule-day-1')).toBeNull();
    fireEvent.change(mode, { target: { value: 'off_hours' } });
    fireEvent.click(screen.getByTestId('bot-schedule-day-6'));
    fireEvent.click(screen.getByTestId('bot-schedule-day-7'));
    fireEvent.change(screen.getByTestId('bot-schedule-to'), {
      target: { value: '19:00' },
    });
    fireEvent.click(screen.getByTestId('bot-schedule-save'));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith('/api/v1/business-profile/schedule', {
        method: 'PUT',
        body: {
          mode: 'off_hours',
          days: [1, 2, 3, 4, 5, 7],
          from: '09:00',
          to: '19:00',
        },
      }),
    );
  });
});
