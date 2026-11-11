import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '@/lib/api';
import type { ContactErasureResult, PersonDetail, Role } from '@/lib/types';
import { PersonPage } from './person-page';

const toastMock = vi.fn();

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'person-1' }),
}));

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, values?: Record<string, unknown>) => {
      if (key === 'people.conversations')
        return `conversations:${String(values?.count)}`;
      if (key === 'people.leads') return `leads:${String(values?.count)}`;
      if (key === 'people.lastActive') return `active:${String(values?.date)}`;
      if (key === 'toast.contactErased') {
        return `erased:${String(values?.conversations)}:${String(values?.messages)}`;
      }
      if (key === 'toast.contactAlreadyErased') return 'already';
      if (key.startsWith('state.')) return key;
      if (key.startsWith('score.')) return key;
      if (key.startsWith('leadStatus.')) return key;
      if (key.startsWith('people.consent.')) return key;
      return key;
    },
    formatDateTime: () => 'date',
  }),
}));

let currentRole: Role = 'OWNER';

vi.mock('./app-shell', () => ({
  useShell: () => ({
    operator: { id: 'op1', displayName: 'Op', role: currentRole },
    timeZone: 'UTC',
  }),
}));

vi.mock('./ui/toast', () => ({
  useToast: () => toastMock,
}));

vi.mock('@/lib/api', () => {
  class MockApiError extends Error {
    constructor(
      readonly status: number,
      readonly code: string,
      readonly i18nKey?: string,
    ) {
      super(code);
    }
  }
  return {
    api: vi.fn(),
    ApiError: MockApiError,
    errorKey: () => 'errors.UNKNOWN',
  };
});

const person: PersonDetail = {
  id: 'person-1',
  displayName: 'Ada Lovelace',
  phone: '+998901234567',
  channels: [
    { contactId: 'c1', channelType: 'telegram' },
    { contactId: 'c2', channelType: 'instagram' },
  ],
  conversationCount: 1,
  leadCount: 1,
  lastConversationId: 'conv-1',
  lastActivityAt: '2026-11-11T10:00:00.000Z',
  marketingOptOut: false,
  createdAt: '2026-11-10T10:00:00.000Z',
  contacts: [
    {
      id: 'c1',
      channelType: 'telegram',
      channelName: 'Main bot',
      name: 'Ada',
      phone: '+998901234567',
      language: 'uz-Latn',
      consentStatus: 'GRANTED',
      marketingOptOut: false,
      createdAt: '2026-11-09T10:00:00.000Z',
    },
  ],
  conversations: [
    {
      id: 'conv-1',
      contactId: 'c1',
      channelType: 'telegram',
      state: 'BOT_ACTIVE',
      updatedAt: '2026-11-11T10:00:00.000Z',
    },
  ],
  leads: [
    {
      id: 'lead-1',
      contactId: 'c1',
      status: 'NEW',
      score: 'HOT',
      stageName: 'New',
      updatedAt: '2026-11-11T10:00:00.000Z',
    },
  ],
};

function renderPage(): { client: QueryClient } {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <PersonPage />
    </QueryClientProvider>,
  );
  return { client };
}

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal(): void {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close(): void {
    this.open = false;
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  currentRole = 'OWNER';
});

describe('PersonPage', () => {
  it('renders header and sections with conversation/lead data', async () => {
    vi.mocked(api).mockResolvedValue(person);
    renderPage();

    expect(await screen.findByTestId('person-header')).toBeInTheDocument();
    expect(screen.getAllByText('Ada Lovelace').length).toBeGreaterThan(0);
    expect(screen.getByTestId('person-contacts')).toBeInTheDocument();
    expect(screen.getByTestId('person-conversations')).toBeInTheDocument();
    expect(screen.getByTestId('person-leads')).toBeInTheDocument();
    expect(screen.getByTestId('person-contact')).toBeInTheDocument();
    expect(screen.getByTestId('person-conversation')).toBeInTheDocument();
    expect(screen.getByTestId('person-lead')).toBeInTheDocument();
    expect(screen.getByText('state.BOT_ACTIVE')).toBeInTheDocument();
    expect(screen.getByText('score.HOT')).toBeInTheDocument();
    expect(screen.getByText('leadStatus.NEW')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'people.openConversation' }),
    ).toHaveAttribute('href', '/inbox?scope=all&c=conv-1');
  });

  it('shows erase action per contact only for OWNER and erases with toast/invalidation', async () => {
    const erased: ContactErasureResult = {
      contactId: 'c1',
      alreadyErased: false,
      conversations: 1,
      messagesRedacted: 2,
    };
    vi.mocked(api).mockImplementation(
      (path: string, options?: { method?: string }) => {
        if (path === '/api/v1/people/person-1' && !options?.method) {
          return Promise.resolve(person);
        }
        if (path === '/api/v1/contacts/c1' && options?.method === 'DELETE') {
          return Promise.resolve(erased);
        }
        return Promise.reject(new Error(`unexpected ${path}`));
      },
    );

    const { client } = renderPage();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const eraseBtn = await screen.findByTestId('person-contact-erase');
    fireEvent.click(eraseBtn);
    expect(screen.getByTestId('confirm-dialog')).toBeVisible();
    fireEvent.click(screen.getByTestId('confirm-accept'));

    await waitFor(() => {
      expect(api).toHaveBeenCalledWith('/api/v1/contacts/c1', {
        method: 'DELETE',
      });
    });
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith('erased:1:2'));
    await waitFor(() => {
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: ['person', 'person-1'],
      });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['people'] });
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: ['conversations'],
      });
    });
  });

  it('hides erase action for non-OWNER roles', async () => {
    currentRole = 'OPERATOR';
    vi.mocked(api).mockResolvedValue(person);
    renderPage();
    await screen.findByTestId('person-contact');
    expect(screen.queryByTestId('person-contact-erase')).toBeNull();
  });

  it('renders 404 state', async () => {
    vi.mocked(api).mockRejectedValue(new ApiError(404, 'NOT_FOUND'));
    renderPage();
    expect(await screen.findByTestId('person-not-found')).toBeInTheDocument();
    expect(screen.getByText('people.notFound')).toBeInTheDocument();
  });
});
