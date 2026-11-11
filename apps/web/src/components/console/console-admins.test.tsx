import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { platformApi } from '@/lib/api';
import { ConsoleAdmins } from './console-admins';

let canWrite = true;

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (k: string, v?: Record<string, unknown>) =>
      v ? `${k}:${JSON.stringify(v)}` : k,
    formatDateTime: () => 'date',
  }),
}));

vi.mock('./console-shell', () => ({
  useConsole: () => ({ admin: { id: 'me' }, canWrite }),
}));

vi.mock('@/lib/api', () => ({
  platformApi: vi.fn(),
  errorKey: () => 'errors.UNKNOWN',
}));

vi.mock('../invite-link-box', () => ({
  InviteLinkBox: ({ path }: { path: string }) => (
    <div data-testid="invite-link">{path}</div>
  ),
}));

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close() {
    this.open = false;
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  canWrite = true;
});

function renderAdmins() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ConsoleAdmins />
    </QueryClientProvider>,
  );
}

const admins = [
  {
    id: 'me',
    displayName: 'Me',
    email: 'me@x.io',
    role: 'PLATFORM_OWNER',
    isActive: true,
    invitePending: false,
    inviteExpiresAt: null,
  },
  {
    id: 'a2',
    displayName: 'Other',
    email: 'o@x.io',
    role: 'PLATFORM_SUPPORT',
    isActive: true,
    invitePending: false,
    inviteExpiresAt: null,
  },
];

describe('ConsoleAdmins', () => {
  it('denies read-only/support users', () => {
    canWrite = false;
    renderAdmins();
    expect(screen.getByText('errors.FORBIDDEN')).toBeInTheDocument();
    expect(platformApi).not.toHaveBeenCalled();
  });

  it('deactivates another admin only after confirmation', async () => {
    vi.mocked(platformApi).mockImplementation(
      (path: string, options?: { method?: string }) => {
        if (path === '/api/v1/platform/admins' && !options?.method)
          return Promise.resolve({ admins });
        if (
          path === '/api/v1/platform/admins/a2/deactivate' &&
          options?.method === 'POST'
        )
          return Promise.resolve({});
        return Promise.reject(new Error(path));
      },
    );
    renderAdmins();
    expect(await screen.findAllByTestId('admin-row')).toHaveLength(2);
    const buttons = screen.getAllByTestId('admin-deactivate');
    fireEvent.click(buttons[0]);
    expect(screen.getByTestId('confirm-dialog')).toBeVisible();
    expect(platformApi).not.toHaveBeenCalledWith(
      '/api/v1/platform/admins/a2/deactivate',
      expect.anything(),
    );
    fireEvent.click(screen.getByTestId('confirm-accept'));
    await waitFor(() =>
      expect(platformApi).toHaveBeenCalledWith(
        '/api/v1/platform/admins/a2/deactivate',
        { method: 'POST' },
      ),
    );
  });

  it('invites admin and shows invite link', async () => {
    vi.mocked(platformApi).mockImplementation(
      (path: string, options?: { method?: string }) => {
        if (path === '/api/v1/platform/admins' && !options?.method)
          return Promise.resolve({ admins });
        if (path === '/api/v1/platform/admins' && options?.method === 'POST')
          return Promise.resolve({
            id: 'i',
            email: 'n@x.io',
            role: 'PLATFORM_SUPPORT',
            expiresAt: 'x',
            path: '/invite/p',
          });
        return Promise.reject(new Error(path));
      },
    );
    renderAdmins();
    await screen.findAllByTestId('admin-row');
    fireEvent.click(screen.getByTestId('admin-invite'));
    fireEvent.change(screen.getByTestId('admin-name'), {
      target: { value: 'New' },
    });
    fireEvent.change(screen.getByTestId('invite-email'), {
      target: { value: 'n@x.io' },
    });
    fireEvent.click(screen.getByTestId('invite-submit'));
    expect(await screen.findByTestId('invite-link')).toHaveTextContent(
      '/invite/p',
    );
  });
});
