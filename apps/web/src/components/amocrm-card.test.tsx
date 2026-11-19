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
import { AmocrmCard } from './amocrm-card';

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    formatDateTime: () => 'date',
  }),
}));
vi.mock('./ui/toast', () => ({ useToast: () => vi.fn() }));
vi.mock('./crm-stage-sync', () => ({
  CrmStageSync: (props: { provider?: string }) => (
    <div data-testid="sync-stub">{props.provider}</div>
  ),
}));
vi.mock('@/lib/api', () => ({
  api: vi.fn(),
  errorKey: () => 'errors.UNKNOWN',
}));

afterEach(() => {
  cleanup();
  vi.mocked(api).mockReset();
});

function renderIt(
  row: Parameters<typeof AmocrmCard>[0]['row'],
  onChanged = vi.fn(),
): void {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <AmocrmCard row={row} secretsConfigured onChanged={onChanged} />
    </QueryClientProvider>,
  );
}

describe('AmocrmCard', () => {
  it('connects with subdomain and token and clears the token', async () => {
    const onChanged = vi.fn();
    vi.mocked(api).mockResolvedValue({});
    renderIt(undefined, onChanged);
    const token = screen.getByTestId('amocrm-token') as HTMLInputElement;
    expect(token.type).toBe('password');
    expect(
      (screen.getByTestId('amocrm-connect') as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.change(screen.getByTestId('amocrm-subdomain'), {
      target: { value: ' shop ' },
    });
    fireEvent.change(token, { target: { value: 'long-token-value' } });
    fireEvent.click(screen.getByTestId('amocrm-connect'));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith('/api/v1/connectors/amocrm', {
        method: 'POST',
        body: { subdomain: 'shop', token: 'long-token-value' },
      }),
    );
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(token.value).toBe('');
  });

  it('when connected shows the pipeline choice and the stage sync, and saves a choice', async () => {
    vi.mocked(api).mockImplementation(async (_path, options) => ({
      pipelines: [
        { id: 1, name: 'Main', isMain: true },
        { id: 2, name: 'Second', isMain: false },
      ],
      pipelineId: options?.method === 'PUT' ? 2 : null,
    }));
    renderIt({
      id: 'c1',
      connectorKey: 'amocrm',
      status: 'ACTIVE',
      configured: true,
    });
    expect(screen.queryByTestId('amocrm-token')).toBeNull();
    expect(screen.getByTestId('sync-stub').textContent).toBe('amocrm');
    const select = (await screen.findByTestId(
      'amocrm-pipeline-select',
    )) as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    fireEvent.change(select, { target: { value: '2' } });
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        '/api/v1/connectors/c1/amocrm/pipeline',
        { method: 'PUT', body: { pipelineId: 2 } },
      ),
    );
    expect(screen.getByTestId('amocrm-disable')).toBeTruthy();
    expect(screen.getByTestId('amocrm-disconnect')).toBeTruthy();
  });
});
