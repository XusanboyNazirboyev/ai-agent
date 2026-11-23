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
import { BusinessProfileCard } from './business-profile-card';

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('./ui/toast', () => ({ useToast: () => vi.fn() }));
vi.mock('@/lib/api', () => ({
  api: vi.fn(),
  errorKey: (e: unknown) =>
    `errors.${(e as { code?: string })?.code ?? 'UNKNOWN'}`,
}));

const stored = {
  name: 'Sayohat Tour',
  address: '',
  phone: '+998 90 123 45 67',
  hours: '',
  website: '',
};

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

describe('BusinessProfileCard (owner 2026-11-23)', () => {
  it('loads the stored details and saves the edited ones', async () => {
    vi.mocked(api).mockImplementation(
      (path, init) =>
        Promise.resolve(init?.method === 'PUT' ? init.body : stored) as never,
    );
    view(<BusinessProfileCard canChange />);
    await waitFor(() =>
      expect(screen.getByTestId('profile-name')).toHaveValue('Sayohat Tour'),
    );
    fireEvent.change(screen.getByTestId('profile-address'), {
      target: { value: 'Toshkent' },
    });
    fireEvent.click(screen.getByTestId('profile-save'));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith('/api/v1/business-profile', {
        method: 'PUT',
        body: { ...stored, address: 'Toshkent' },
      }),
    );
  });

  it('is read-only for operators without the right', async () => {
    vi.mocked(api).mockResolvedValue(stored as never);
    view(<BusinessProfileCard canChange={false} />);
    await waitFor(() =>
      expect(screen.getByTestId('profile-phone')).toHaveValue(stored.phone),
    );
    expect(screen.getByTestId('profile-phone')).toBeDisabled();
    expect(screen.queryByTestId('profile-save')).toBeNull();
  });
});
