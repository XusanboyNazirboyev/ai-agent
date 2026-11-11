import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import type { Role, TeamView } from '@/lib/types';
import { TeamPage } from './team-page';

let actorRole: Role = 'OWNER';

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${JSON.stringify(values)}` : key,
    formatDateTime: () => 'date',
  }),
}));

vi.mock('./app-shell', () => ({
  useShell: () => ({
    operator: { id: 'me', displayName: 'Me', role: actorRole },
    timeZone: 'UTC',
  }),
}));

vi.mock('@/lib/api', () => ({
  api: vi.fn(),
  errorKey: () => 'errors.UNKNOWN',
}));

vi.mock('./invite-link-box', () => ({
  InviteLinkBox: ({ path }: { path: string }) => (
    <div data-testid="invite-link">{path}</div>
  ),
}));

const view: TeamView = {
  operators: [
    {
      id: 'me',
      displayName: 'Me',
      role: 'OWNER',
      isActive: true,
      email: 'me@x.io',
      createdAt: 't',
    },
    {
      id: 'op2',
      displayName: 'Op Two',
      role: 'OPERATOR',
      isActive: true,
      email: 'op2@x.io',
      createdAt: 't',
    },
  ],
  invites: [
    {
      id: 'inv1',
      email: 'new@x.io',
      role: 'VIEWER',
      expiresAt: '2026-11-20T00:00:00.000Z',
      createdAt: 't',
    },
  ],
  limits: { maxOperators: 10, seatsUsed: 2 },
};

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <TeamPage />
    </QueryClientProvider>,
  );
}

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
  actorRole = 'OWNER';
});

describe('TeamPage', () => {
  it('is hidden for non-managers', () => {
    actorRole = 'OPERATOR';
    renderPage();
    expect(screen.getByText('team.managersOnly')).toBeInTheDocument();
    expect(api).not.toHaveBeenCalled();
  });

  it('renders members/invites and performs role change via confirmation', async () => {
    vi.mocked(api).mockImplementation(
      (path: string, options?: { method?: string }) => {
        if (path === '/api/v1/team' && !options?.method)
          return Promise.resolve(view);
        if (
          path === '/api/v1/team/operators/op2' &&
          options?.method === 'PATCH'
        ) {
          return Promise.resolve({ ...view.operators[1], role: 'ADMIN' });
        }
        return Promise.reject(new Error(`unexpected ${path}`));
      },
    );
    renderPage();
    expect(await screen.findByTestId('team-seats')).toBeInTheDocument();
    expect(screen.getAllByTestId('team-member').length).toBe(2);
    const selects = screen.getAllByTestId('member-role');
    fireEvent.change(selects[0], { target: { value: 'ADMIN' } });
    expect(screen.getByTestId('confirm-dialog')).toBeVisible();
    fireEvent.click(screen.getByTestId('confirm-accept'));
    await waitFor(() => {
      expect(api).toHaveBeenCalledWith('/api/v1/team/operators/op2', {
        method: 'PATCH',
        body: { role: 'ADMIN' },
      });
    });
  });

  it('revokes pending invite and creates invite link', async () => {
    vi.mocked(api).mockImplementation(
      (path: string, options?: { method?: string; body?: unknown }) => {
        if (path === '/api/v1/team' && !options?.method)
          return Promise.resolve(view);
        if (
          path === '/api/v1/team/invites/inv1' &&
          options?.method === 'DELETE'
        )
          return Promise.resolve({});
        if (path === '/api/v1/team/invites' && options?.method === 'POST') {
          return Promise.resolve({
            id: 'i2',
            email: 'x@y.z',
            role: 'OPERATOR',
            expiresAt: 'x',
            token: 't',
            path: '/invite/t',
          });
        }
        return Promise.reject(new Error(`unexpected ${path}`));
      },
    );
    renderPage();
    await screen.findByTestId('team-invite-row');
    fireEvent.click(screen.getByTestId('team-invite-revoke'));
    fireEvent.click(screen.getByTestId('confirm-accept'));
    await waitFor(() => {
      expect(api).toHaveBeenCalledWith('/api/v1/team/invites/inv1', {
        method: 'DELETE',
      });
    });
    fireEvent.click(screen.getByTestId('team-invite'));
    fireEvent.change(screen.getByTestId('invite-email'), {
      target: { value: 'x@y.z' },
    });
    fireEvent.click(screen.getByTestId('invite-submit'));
    expect(await screen.findByTestId('invite-link')).toHaveTextContent(
      '/invite/t',
    );
  });
});
