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
import type { ContactErasureResult, ContactItem, Role } from '@/lib/types';
import { ContactsPage } from './contacts-page';

const toastMock = vi.fn();

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, values?: Record<string, unknown>) => {
      if (key === 'toast.contactErased') {
        return `erased:${String(values?.conversations)}:${String(values?.messages)}`;
      }
      if (key === 'toast.contactAlreadyErased') return 'already';
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

vi.mock('@/lib/api', () => ({
  api: vi.fn(),
  errorKey: () => 'errors.FORBIDDEN',
}));

const contact: ContactItem = {
  id: 'contact-1',
  name: 'Ada Lovelace',
  phone: '+998901234567',
  language: 'uz-Latn',
  channelType: 'telegram',
  marketingOptOut: false,
  conversationCount: 2,
  lastConversationId: 'conv-1',
  lastActivityAt: '2026-11-11T10:00:00.000Z',
  createdAt: '2026-11-10T10:00:00.000Z',
};

function renderPage(): { client: QueryClient } {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ContactsPage />
    </QueryClientProvider>,
  );
  return { client };
}

function setupList(): void {
  vi.mocked(api).mockImplementation(
    (path: string, options?: { method?: string }) => {
      if (path.startsWith('/api/v1/contacts?') && !options?.method) {
        return Promise.resolve({ items: [contact], nextCursor: null });
      }
      return Promise.reject(new Error(`unexpected call: ${path}`));
    },
  );
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

describe('ContactsPage erase contact', () => {
  it('shows the erase action only to the owner', async () => {
    setupList();
    renderPage();
    expect(await screen.findByTestId('contact-erase')).toBeInTheDocument();

    cleanup();
    vi.clearAllMocks();
    currentRole = 'OPERATOR';
    setupList();
    renderPage();
    await screen.findByTestId('contact-item');
    expect(screen.queryByTestId('contact-erase')).toBeNull();
  });

  it('opens confirmation, erases contact, shows toast, and refreshes lists', async () => {
    const erased: ContactErasureResult = {
      contactId: 'contact-1',
      alreadyErased: false,
      conversations: 3,
      messagesRedacted: 7,
    };
    vi.mocked(api).mockImplementation(
      (path: string, options?: { method?: string }) => {
        if (path.startsWith('/api/v1/contacts?') && !options?.method) {
          return Promise.resolve({ items: [contact], nextCursor: null });
        }
        if (
          path === '/api/v1/contacts/contact-1' &&
          options?.method === 'DELETE'
        ) {
          return Promise.resolve(erased);
        }
        return Promise.reject(
          new Error(`unexpected call: ${path} ${options?.method ?? 'GET'}`),
        );
      },
    );

    const { client } = renderPage();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    fireEvent.click(await screen.findByTestId('contact-erase'));

    expect(screen.getByTestId('confirm-dialog')).toBeVisible();
    expect(screen.getByText('contacts.eraseBody')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('confirm-accept'));

    await waitFor(() => {
      expect(api).toHaveBeenCalledWith('/api/v1/contacts/contact-1', {
        method: 'DELETE',
      });
    });
    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith('erased:3:7');
    });
    await waitFor(() => {
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['contacts'] });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['conversations'] });
    });
  });
});
