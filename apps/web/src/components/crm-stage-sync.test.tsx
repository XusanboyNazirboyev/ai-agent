import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import type { StageSyncView } from '@/lib/types';
import { CrmStageSync } from './crm-stage-sync';

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    formatDateTime: () => 'date',
  }),
}));
vi.mock('./ui/toast', () => ({ useToast: () => vi.fn() }));
vi.mock('@/lib/api', () => ({
  api: vi.fn(),
  errorKey: () => 'errors.UNKNOWN',
}));

const view: StageSyncView = {
  enabled: false,
  lastRunAt: null,
  lastErrorCode: 'BITRIX24_NO_AUTH_FOUND',
  portalReachable: true,
  ourStages: [
    { id: 's-won', code: 'WON', name: null, kind: 'WON' },
    { id: 's-new', code: 'NEW', name: 'Fresh', kind: 'OPEN' },
  ],
  stages: [
    {
      externalStageId: 'NEW',
      name: 'Not processed',
      semantics: 'process',
      leadStageId: null,
      saved: false,
    },
    {
      externalStageId: 'CONVERTED',
      name: 'Qualified',
      semantics: 'success',
      leadStageId: 's-won',
      saved: false,
    },
  ],
};

afterEach(() => {
  cleanup();
  vi.mocked(api).mockReset();
});

function renderIt(): void {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <CrmStageSync connectorId="c1" />
    </QueryClientProvider>,
  );
}

describe('CrmStageSync', () => {
  it('shows defaults and the last error in words, and saves the choices', async () => {
    vi.mocked(api).mockImplementation(async (_path, options) =>
      options?.method === 'PUT' ? { ...view, enabled: true } : view,
    );
    renderIt();
    const won = (await screen.findByTestId(
      'stage-map-CONVERTED',
    )) as HTMLSelectElement;
    await waitFor(() => expect(won.value).toBe('s-won'));
    expect(
      (screen.getByTestId('stage-map-NEW') as HTMLSelectElement).value,
    ).toBe('');
    expect(screen.getByTestId('stage-sync-error').textContent).toBe(
      'crmSync.err.auth',
    );
    expect(screen.getByTestId('stage-sync-status').textContent).toBe(
      'crmSync.neverRun',
    );

    fireEvent.click(screen.getByTestId('stage-sync-enabled'));
    fireEvent.change(screen.getByTestId('stage-map-NEW'), {
      target: { value: 's-new' },
    });
    fireEvent.click(screen.getByTestId('stage-sync-save'));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith('/api/v1/connectors/c1/stage-sync', {
        method: 'PUT',
        body: {
          enabled: true,
          mappings: [
            { externalStageId: 'NEW', leadStageId: 's-new' },
            { externalStageId: 'CONVERTED', leadStageId: 's-won' },
          ],
        },
      }),
    );
  });
});
