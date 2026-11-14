import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { I18nProvider } from '@/i18n';
import { PreferencesProvider } from '@/lib/preferences';
import { ToastProvider } from './ui/toast';
import { AppShell } from './app-shell';

vi.mock('@/lib/api', () => ({
  api: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(
      public readonly status: number,
      public readonly code: string,
    ) {
      super(code);
      this.name = 'ApiError';
    }
  },
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => '/inbox',
  useSearchParams: () => new URLSearchParams(),
}));

class FakeEventSource {
  addEventListener = vi.fn();
  removeEventListener = vi.fn();
  close = vi.fn();
  readyState = 0;
  onopen: ((this: EventSource, ev: Event) => void) | null = null;
  onerror: ((this: EventSource, ev: Event) => void) | null = null;
  open(): void {}
}

type Role = 'OWNER' | 'ADMIN' | 'OPERATOR' | 'VIEWER';

const me = (role: Role) => ({
  operator: { id: 'op-1', displayName: 'Op One', role },
  tenant: { timezone: 'Asia/Tashkent', defaultLocale: 'en' },
});

function renderShell(role: Role) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  vi.mocked(api).mockResolvedValue(me(role));
  return render(
    <QueryClientProvider client={client}>
      <I18nProvider>
        <PreferencesProvider>
          <ToastProvider>
            <AppShell>
              <p data-testid="children">children</p>
            </AppShell>
          </ToastProvider>
        </PreferencesProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  global.EventSource = FakeEventSource as unknown as typeof EventSource;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (global as { EventSource?: unknown }).EventSource;
});

function rail(): HTMLElement {
  const rails = screen.getAllByRole('navigation', { name: 'Main navigation' });
  return rails[0];
}

describe('AppShell rail', () => {
  it('shows an operator only the items their role may see', async () => {
    renderShell('OPERATOR');
    await screen.findByTestId('children');
    const links = within(rail()).getAllByRole('link');
    expect(links).toHaveLength(4);
    expect(links.map((link) => link.textContent)).toEqual([
      'Inbox',
      'Leads',
      'Knowledge',
      'Settings',
    ]);
    expect(
      within(rail()).queryByRole('link', { name: 'Analytics' }),
    ).toBeNull();
  });

  it('shows an administrator all five items', async () => {
    renderShell('ADMIN');
    await screen.findByTestId('children');
    const links = within(rail()).getAllByRole('link');
    expect(links).toHaveLength(5);
    expect(links.map((link) => link.textContent)).toEqual([
      'Inbox',
      'Leads',
      'Analytics',
      'Knowledge',
      'Settings',
    ]);
  });

  it('shows a viewer the same read-only items as an operator', async () => {
    renderShell('VIEWER');
    await screen.findByTestId('children');
    const links = within(rail()).getAllByRole('link');
    expect(links).toHaveLength(4);
    expect(links.map((link) => link.textContent)).toEqual([
      'Inbox',
      'Leads',
      'Knowledge',
      'Settings',
    ]);
  });
});
