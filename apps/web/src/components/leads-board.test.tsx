import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { LeadsBoard } from './leads-board';

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    formatDateTime: () => 'date',
  }),
}));

vi.mock('./app-shell', () => ({
  useShell: () => ({
    operator: { id: 'op1', displayName: 'Op', role: 'OPERATOR' },
    timeZone: 'UTC',
  }),
}));

vi.mock('@/lib/api', () => ({
  api: vi.fn(),
  errorKey: () => 'error',
}));

vi.mock('@/components/ui/toast', () => ({
  useToast: () => vi.fn(),
}));

vi.mock('@/lib/export-csv', () => ({
  downloadCsv: vi.fn(),
}));

const stages = [
  { id: 'stage-new', code: 'NEW', name: 'New', position: 0 },
  { id: 'stage-won', code: 'WON', name: 'Won', position: 1 },
];

const leadPage = {
  items: [
    {
      id: 'lead-1',
      score: 'HOT',
      status: 'NEW',
      updatedAt: '2026-11-11T10:00:00.000Z',
      contact: { name: 'Ada Lovelace', phone: null },
      conversation: {
        id: 'conv-1',
        state: 'BOT_ACTIVE',
        channelType: 'telegram',
      },
    },
  ],
  nextCursor: null,
};

function setupApi(): void {
  const mockedApi = vi.mocked(api);
  mockedApi.mockImplementation((path: string) => {
    if (path === '/api/v1/leads/stages') return Promise.resolve(stages);
    if (path.startsWith('/api/v1/leads?')) return Promise.resolve(leadPage);
    return new Promise(() => {
      // Keep mutations pending so optimistic select values can be asserted.
    });
  });
}

describe('LeadsBoard lead card controls', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('keeps optimistic score/status/stage values while mutations are pending', async () => {
    setupApi();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <LeadsBoard />
      </QueryClientProvider>,
    );

    const card = await screen.findByTestId('lead-card');
    const score = within(card).getByTestId('lead-card-score');
    const status = within(card).getByTestId('lead-card-status');
    const stage = within(card).getByTestId('lead-card-stage');

    expect(score).toHaveValue('HOT');
    expect(status).toHaveValue('NEW');
    expect(stage).toHaveValue('stage-new');

    await act(async () => {
      fireEvent.change(score, { target: { value: 'WARM' } });
      fireEvent.change(status, { target: { value: 'WON' } });
      fireEvent.change(stage, { target: { value: 'stage-won' } });
    });

    await waitFor(() => {
      expect(score).toHaveValue('WARM');
      expect(status).toHaveValue('WON');
      expect(stage).toHaveValue('stage-won');
    });

    expect(api).toHaveBeenCalledWith(
      '/api/v1/leads/conversations/conv-1/score',
      expect.objectContaining({ method: 'PUT' }),
    );
    expect(api).toHaveBeenCalledWith(
      '/api/v1/leads/conversations/conv-1/status',
      expect.objectContaining({ method: 'PUT' }),
    );
    expect(api).toHaveBeenCalledWith(
      '/api/v1/leads/lead-1/stage',
      expect.objectContaining({ method: 'PATCH' }),
    );
  });
});
