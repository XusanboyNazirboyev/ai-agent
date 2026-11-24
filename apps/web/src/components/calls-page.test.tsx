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
import { CallsPage, type TelephonyStatus } from './calls-page';
import { visibleCrmSections } from './crm-section-nav';

let role = 'OWNER';
vi.mock('@/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key, formatDateTime: () => 'time' }),
}));
vi.mock('./app-shell', () => ({
  useShell: () => ({ operator: { id: 'o1', displayName: 'O', role } }),
}));
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
const base: TelephonyStatus = {
  minutesLimit: 300,
  secretsConfigured: true,
  account: null,
};

afterEach(() => {
  cleanup();
  vi.mocked(api).mockReset();
  role = 'OWNER';
});

describe('CRM section (owner 2026-11-24)', () => {
  it('shows calls and the report to managers only', () => {
    expect(visibleCrmSections(true).map((s) => s.key)).toEqual([
      'leads',
      'tasks',
      'calls',
      'report',
    ]);
    expect(visibleCrmSections(false).map((s) => s.key)).toEqual([
      'leads',
      'tasks',
    ]);
  });

  it('points to billing when the plan has no call analysis', async () => {
    vi.mocked(api).mockResolvedValue({ ...base, minutesLimit: 0 } as never);
    view(<CallsPage />);
    expect(await screen.findByTestId('calls-plan')).toBeInTheDocument();
    expect(screen.queryByTestId('calls-connect')).toBeNull();
  });

  it('connects OnlinePBX with the domain and key, then shows the domain', async () => {
    vi.mocked(api).mockImplementation(
      (_path, init) =>
        Promise.resolve(
          init?.method === 'POST'
            ? {
                ...base,
                account: {
                  provider: 'ONLINEPBX',
                  domain: 'shop.onpbx.ru',
                  enabled: true,
                  connected: true,
                  lastError: null,
                  polledUntil: null,
                },
              }
            : base,
        ) as never,
    );
    view(<CallsPage />);
    fireEvent.change(await screen.findByTestId('calls-domain-input'), {
      target: { value: 'shop.onpbx.ru' },
    });
    fireEvent.change(screen.getByTestId('calls-key-input'), {
      target: { value: 'secret-key' },
    });
    fireEvent.click(screen.getByTestId('calls-connect'));
    await waitFor(() =>
      expect(screen.getByTestId('calls-domain')).toHaveTextContent(
        'shop.onpbx.ru',
      ),
    );
    expect(api).toHaveBeenCalledWith('/api/v1/telephony/onlinepbx', {
      method: 'POST',
      body: { domain: 'shop.onpbx.ru', apiKey: 'secret-key' },
    });
  });

  it('asks nothing of the API for an operator', () => {
    role = 'OPERATOR';
    view(<CallsPage />);
    expect(api).not.toHaveBeenCalled();
  });
});
