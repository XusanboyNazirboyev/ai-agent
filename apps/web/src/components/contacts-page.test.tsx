import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import type { PersonItem } from '@/lib/types';
import { ContactsPage } from './contacts-page';

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, values?: Record<string, unknown>) => {
      if (key === 'people.conversations')
        return `conversations:${String(values?.count)}`;
      if (key === 'people.leads') return `leads:${String(values?.count)}`;
      if (key === 'people.lastActive') return `active:${String(values?.date)}`;
      return key;
    },
    formatDateTime: () => 'date',
  }),
}));

vi.mock('./app-shell', () => ({
  useShell: () => ({
    operator: { id: 'op1', displayName: 'Op', role: 'VIEWER' },
    timeZone: 'UTC',
  }),
}));

vi.mock('@/lib/api', () => ({
  api: vi.fn(),
  errorKey: () => 'errors.UNKNOWN',
}));

const person: PersonItem = {
  id: 'person-1',
  displayName: 'Ada Lovelace',
  phone: '+998901234567',
  channels: [
    { contactId: 'c1', channelType: 'telegram' },
    { contactId: 'c2', channelType: 'instagram' },
  ],
  conversationCount: 2,
  leadCount: 1,
  lastConversationId: 'conv-1',
  lastActivityAt: '2026-11-11T10:00:00.000Z',
  marketingOptOut: false,
  createdAt: '2026-11-10T10:00:00.000Z',
};

function renderPage(): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ContactsPage />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ContactsPage people list', () => {
  it('renders person rows with channel badges, counts and links', async () => {
    vi.mocked(api).mockImplementation((path: string) => {
      if (path.startsWith('/api/v1/people?')) {
        return Promise.resolve({ items: [person], nextCursor: null });
      }
      return Promise.reject(new Error(`unexpected call: ${path}`));
    });

    renderPage();

    expect(await screen.findByTestId('person-item')).toBeInTheDocument();
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByText('+998901234567')).toBeInTheDocument();
    expect(screen.getByText('Telegram')).toBeInTheDocument();
    expect(screen.getByText('Instagram')).toBeInTheDocument();
    expect(screen.getByText('conversations:2')).toBeInTheDocument();
    expect(screen.getByText('leads:1')).toBeInTheDocument();
    expect(screen.getByText('active:date')).toBeInTheDocument();

    const open = screen.getByRole('link', { name: 'people.open' });
    expect(open).toHaveAttribute('href', '/inbox?scope=all&c=conv-1');
    const card = screen.getByTestId('person-open-card');
    expect(card).toHaveAttribute('href', '/contacts/person-1');
    expect(screen.queryByTestId('contact-erase')).toBeNull();
  });

  it('sends search query and renders empty state', async () => {
    vi.mocked(api).mockImplementation((path: string) => {
      if (path === '/api/v1/people?limit=25') {
        return Promise.resolve({ items: [person], nextCursor: null });
      }
      if (path === '/api/v1/people?limit=25&q=Ada') {
        return Promise.resolve({ items: [], nextCursor: null });
      }
      return Promise.reject(new Error(`unexpected call: ${path}`));
    });

    renderPage();
    await screen.findByTestId('person-item');

    fireEvent.change(screen.getByLabelText('people.search'), {
      target: { value: 'Ada' },
    });

    expect(await screen.findByText('people.emptyFiltered')).toBeInTheDocument();
    expect(api).toHaveBeenCalledWith('/api/v1/people?limit=25&q=Ada');
  });

  it('renders default empty state without search', async () => {
    vi.mocked(api).mockResolvedValue({ items: [], nextCursor: null });
    renderPage();
    expect(await screen.findByText('people.empty')).toBeInTheDocument();
  });
});
