import { act, cleanup, render, screen, within } from '@testing-library/react';
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
  static last: FakeEventSource | undefined;
  listeners = new Map<string, (message: MessageEvent) => void>();
  constructor() {
    FakeEventSource.last = this;
  }
  addEventListener = vi.fn(
    (type: string, listener: (message: MessageEvent) => void) => {
      this.listeners.set(type, listener);
    },
  );
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
  vi.mocked(api).mockImplementation(
    (path: string) =>
      Promise.resolve(
        path.includes('/conversations')
          ? { items: [], nextCursor: null }
          : me(role),
      ) as never,
  );
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
    expect(links).toHaveLength(5);
    expect(links.map((link) => link.textContent)).toEqual([
      'Today',
      'Inbox',
      'Leads',
      'Tasks',
      'Settings',
    ]);
    expect(
      within(rail()).queryByRole('link', { name: 'Analytics' }),
    ).toBeNull();
  });

  it('shows an administrator every item', async () => {
    renderShell('ADMIN');
    await screen.findByTestId('children');
    const links = within(rail()).getAllByRole('link');
    expect(links).toHaveLength(6);
    expect(links.map((link) => link.textContent)).toEqual([
      'Today',
      'Inbox',
      'Leads',
      'Tasks',
      'Analytics',
      'Settings',
    ]);
  });

  it('shows a viewer the same read-only items as an operator', async () => {
    renderShell('VIEWER');
    await screen.findByTestId('children');
    const links = within(rail()).getAllByRole('link');
    expect(links).toHaveLength(5);
    expect(links.map((link) => link.textContent)).toEqual([
      'Today',
      'Inbox',
      'Leads',
      'Tasks',
      'Settings',
    ]);
  });
});

describe('AppShell task.due', () => {
  const notifications: Array<{
    title: string;
    options: NotificationOptions;
    onclick?: () => void;
  }> = [];
  class FakeNotification {
    static permission = 'granted';
    onclick: (() => void) | undefined;
    close = vi.fn();
    constructor(
      public title: string,
      public options: NotificationOptions,
    ) {
      notifications.push(this);
    }
  }
  const visibility = (value: 'hidden' | 'visible'): void => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => value,
    });
  };
  async function fire(data: Record<string, unknown>): Promise<void> {
    renderShell('OPERATOR');
    await screen.findByTestId('children');
    const listener = FakeEventSource.last!.listeners.get('task.due')!;
    act(() => {
      listener({
        data: JSON.stringify({
          conversationId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
          handoverId: null,
          messageId: null,
          ...data,
        }),
        lastEventId: '5',
      } as MessageEvent);
    });
  }
  beforeEach(() => {
    notifications.length = 0;
    FakeNotification.permission = 'granted';
    vi.stubGlobal('Notification', FakeNotification);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    visibility('visible');
  });

  it('shows a system notification with the title when the tab is hidden', async () => {
    visibility('hidden');
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => undefined);
    await fire({ taskTitle: 'Call Ali' });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.options.body).toBe('Call Ali');
    notifications[0]!.onclick?.();
    expect(focus).toHaveBeenCalled();
  });

  it('uses the generic text when the event carries no title (old payload)', async () => {
    visibility('hidden');
    await fire({});
    expect(notifications[0]!.options.body).toBe('A task is due.');
  });

  it('stays quiet when permission is not granted or the tab is visible', async () => {
    visibility('hidden');
    FakeNotification.permission = 'denied';
    await fire({ taskTitle: 'x' });
    expect(notifications).toHaveLength(0);
  });

  it('works without the Notification API', async () => {
    vi.stubGlobal('Notification', undefined);
    visibility('hidden');
    await fire({ taskTitle: 'x' });
    expect(notifications).toHaveLength(0);
    expect(await screen.findByText('A task is due.')).toBeTruthy();
  });
});
