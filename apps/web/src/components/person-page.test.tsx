import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '@/lib/api';
import type {
  ContactErasureResult,
  PersonDetail,
  PersonErasureResult,
  PersonItem,
  PersonMergePreview,
  Role,
} from '@/lib/types';
import { PersonPage } from './person-page';

const toastMock = vi.fn();
const pushMock = vi.fn();

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'person-1' }),
  useRouter: () => ({ push: pushMock }),
}));

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, values?: Record<string, unknown>) => {
      if (key === 'people.conversations')
        return `conversations:${String(values?.count)}`;
      if (key === 'people.leads') return `leads:${String(values?.count)}`;
      if (key === 'people.lastActive') return `active:${String(values?.date)}`;
      if (key === 'people.duplicatesBanner')
        return `duplicates:${String(values?.count)}`;
      if (key === 'people.mergeDirection')
        return `merge:${String(values?.source)}->${String(values?.survivor)}`;
      if (key === 'people.mergeMoves.contacts')
        return `contacts:${String(values?.count)}`;
      if (key === 'people.mergeMoves.conversations')
        return `conversationsMove:${String(values?.count)}`;
      if (key === 'people.mergeMoves.leads')
        return `leadsMove:${String(values?.count)}`;
      if (key === 'people.lastMergeNote')
        return `lastMerge:${String(values?.date)}:${String(values?.count)}`;
      if (key === 'toast.contactErased') {
        return `erased:${String(values?.conversations)}:${String(values?.messages)}`;
      }
      if (key === 'toast.contactAlreadyErased') return 'already';
      if (key === 'toast.personErased')
        return `person-erased:${String(values?.contacts)}`;
      if (key === 'people.erasePersonBody')
        return `erase-person-body:${String(values?.name)}:${String(values?.contacts)}:${String(values?.conversations)}`;
      if (key === 'people.mergeSuccess') return 'merged';
      if (key === 'people.unmergeSuccess') return 'unmerged';
      if (key === 'errors.MERGE_REFUSED') return 'merge-refused';
      if (key === 'errors.SAME_PERSON') return 'same-person';
      if (key === 'errors.NOT_FOUND') return 'not-found';
      if (key === 'errors.INVALID_BODY') return 'invalid-body';
      if (key === 'errors.UNMERGE_BLOCKED') return 'unmerge-blocked';
      if (key === 'errors.UNKNOWN') return 'unknown';
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
    errorKey: (e: unknown) => {
      if (e instanceof MockApiError) {
        if (e.i18nKey) return e.i18nKey;
        return `errors.${e.code}`;
      }
      return 'errors.UNKNOWN';
    },
  };
});

const personItem: PersonItem = {
  id: 'person-1',
  displayName: 'Ada Lovelace',
  phone: '+998901234567',
  channels: [{ contactId: 'c1', channelType: 'telegram' }],
  conversationCount: 1,
  leadCount: 1,
  lastConversationId: 'conv-1',
  lastActivityAt: '2026-11-11T10:00:00.000Z',
  marketingOptOut: false,
  createdAt: '2026-11-10T10:00:00.000Z',
};

const duplicatePerson: PersonItem = {
  ...personItem,
  id: 'person-2',
  displayName: 'Ada Byron',
  channels: [{ contactId: 'c2', channelType: 'instagram' }],
  lastConversationId: 'conv-2',
};

const person: PersonDetail = {
  ...personItem,
  channels: [
    { contactId: 'c1', channelType: 'telegram' },
    { contactId: 'c2', channelType: 'instagram' },
  ],
  lastMerge: null,
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

const preview: PersonMergePreview = {
  source: duplicatePerson,
  survivor: personItem,
  moves: { contacts: 2, conversations: 3, leads: 1 },
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

function mockApi(
  opts: {
    duplicates?: PersonItem[] | 'error';
    previewResult?: PersonMergePreview | 'error';
    mergeResult?: unknown | Error;
    unmergeResult?: unknown | Error;
    personDetail?: PersonDetail;
  } = {},
): void {
  const detail = opts.personDetail ?? person;
  vi.mocked(api).mockImplementation(
    (path: string, options?: { method?: string; body?: unknown }) => {
      if (path === '/api/v1/people/person-1' && !options?.method) {
        return Promise.resolve(detail);
      }
      if (path === '/api/v1/people/person-1/duplicates') {
        if (opts.duplicates === 'error')
          return Promise.reject(new Error('dup-fail'));
        return Promise.resolve({ items: opts.duplicates ?? [] });
      }
      if (path.startsWith('/api/v1/people/person-2/merge-preview')) {
        if (opts.previewResult === 'error')
          return Promise.reject(new Error('preview-fail'));
        return Promise.resolve(opts.previewResult ?? preview);
      }
      if (
        path === '/api/v1/people/person-2/merge' &&
        options?.method === 'POST'
      ) {
        if (opts.mergeResult instanceof Error)
          return Promise.reject(opts.mergeResult);
        return Promise.resolve(opts.mergeResult ?? { ok: true });
      }
      if (
        path === '/api/v1/people/person-1/unmerge' &&
        options?.method === 'POST'
      ) {
        if (opts.unmergeResult instanceof Error)
          return Promise.reject(opts.unmergeResult);
        return Promise.resolve(opts.unmergeResult ?? { ok: true });
      }
      if (path === '/api/v1/contacts/c1' && options?.method === 'DELETE') {
        const erased: ContactErasureResult = {
          contactId: 'c1',
          alreadyErased: false,
          conversations: 1,
          messagesRedacted: 2,
        };
        return Promise.resolve(erased);
      }
      return Promise.reject(new Error(`unexpected ${path}`));
    },
  );
}

describe('PersonPage', () => {
  it('renders header and sections with conversation/lead data', async () => {
    mockApi();
    renderPage();

    expect(await screen.findByTestId('person-header')).toBeInTheDocument();
    expect(screen.getAllByText('Ada Lovelace').length).toBeGreaterThan(0);
    expect(screen.getByTestId('person-contacts')).toBeInTheDocument();
    expect(screen.getByTestId('person-conversations')).toBeInTheDocument();
    expect(screen.getByTestId('person-leads')).toBeInTheDocument();
    expect(screen.getByText('state.BOT_ACTIVE')).toBeInTheDocument();
    expect(screen.getByText('score.HOT')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'people.openConversation' }),
    ).toHaveAttribute('href', '/inbox?scope=all&c=conv-1');
  });

  it('hides duplicate banner when no candidates and on error', async () => {
    mockApi({ duplicates: [] });
    renderPage();
    await screen.findByTestId('person-header');
    expect(screen.queryByTestId('person-duplicates')).toBeNull();

    cleanup();
    mockApi({ duplicates: 'error' });
    renderPage();
    await screen.findByTestId('person-header');
    expect(screen.queryByTestId('person-duplicates')).toBeNull();
  });

  it('shows duplicate banner and merge buttons for ADMIN/OWNER but not for OPERATOR/VIEWER', async () => {
    currentRole = 'OPERATOR';
    mockApi({
      duplicates: [duplicatePerson],
    });
    renderPage();
    expect(await screen.findByTestId('person-duplicates')).toBeInTheDocument();
    expect(screen.queryByTestId('merge-candidate-into-person')).toBeNull();
    expect(screen.queryByTestId('merge-person-into-candidate')).toBeNull();
    expect(screen.getByTestId('person-duplicate-open-card')).toHaveAttribute(
      'href',
      '/contacts/person-2',
    );

    cleanup();
    currentRole = 'ADMIN';
    mockApi({
      duplicates: [duplicatePerson],
    });
    renderPage();
    await screen.findByTestId('person-duplicates');
    expect(
      screen.getByTestId('merge-candidate-into-person'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('merge-person-into-candidate'),
    ).toBeInTheDocument();
  });

  it('shows merge dialog with direction and preview counts, submit disabled until reason valid', async () => {
    mockApi({
      duplicates: [duplicatePerson],
    });
    renderPage();
    await screen.findByTestId('person-duplicates');
    fireEvent.click(screen.getByTestId('merge-candidate-into-person'));

    expect(await screen.findByTestId('merge-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('merge-direction')).toHaveTextContent(
      'merge:Ada Byron->Ada Lovelace',
    );
    expect(await screen.findByTestId('merge-preview-counts')).toHaveTextContent(
      'contacts:2',
    );
    expect(screen.getByTestId('merge-preview-counts')).toHaveTextContent(
      'conversationsMove:3',
    );
    expect(screen.getByTestId('merge-preview-counts')).toHaveTextContent(
      'leadsMove:1',
    );
    const submit = screen.getByTestId('merge-confirm');
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByTestId('merge-reason-input'), {
      target: { value: 'ab' },
    });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByTestId('merge-reason-input'), {
      target: { value: 'abc' },
    });
    expect(submit).not.toBeDisabled();
  });

  it('merge success calls correct URL/body, invalidates and navigates', async () => {
    mockApi({
      duplicates: [duplicatePerson],
    });
    const { client } = renderPage();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    await screen.findByTestId('person-duplicates');
    fireEvent.click(screen.getByTestId('merge-candidate-into-person'));
    await screen.findByTestId('merge-dialog');
    fireEvent.change(screen.getByTestId('merge-reason-input'), {
      target: { value: 'same customer' },
    });
    fireEvent.click(screen.getByTestId('merge-confirm'));

    await waitFor(() => {
      expect(api).toHaveBeenCalledWith('/api/v1/people/person-2/merge', {
        method: 'POST',
        body: { intoId: 'person-1', reason: 'same customer' },
      });
    });
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith('merged'));
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['people'] }),
    );
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['person'] }),
    );
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: ['person-duplicates'],
      }),
    );
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: ['conversations'],
      }),
    );
    await waitFor(() =>
      expect(pushMock).toHaveBeenCalledWith('/contacts/person-1'),
    );
  });

  it.each([
    ['MERGE_REFUSED', 'merge-refused'],
    ['SAME_PERSON', 'same-person'],
    ['NOT_FOUND', 'not-found'],
    ['INVALID_BODY', 'invalid-body'],
  ])(
    'maps merge error %s to message and keeps dialog open',
    async (code, text) => {
      mockApi({
        duplicates: [duplicatePerson],
        mergeResult: new ApiError(409, code),
      });
      renderPage();
      await screen.findByTestId('person-duplicates');
      fireEvent.click(screen.getByTestId('merge-candidate-into-person'));
      await screen.findByTestId('merge-dialog');
      fireEvent.change(screen.getByTestId('merge-reason-input'), {
        target: { value: 'reason' },
      });
      fireEvent.click(screen.getByTestId('merge-confirm'));
      expect(await screen.findByTestId('merge-error')).toHaveTextContent(text);
      expect(screen.getByTestId('merge-dialog')).toBeInTheDocument();
    },
  );

  it('shows unmerge only with lastMerge and right role, confirm required and handles 409', async () => {
    const withMerge: PersonDetail = {
      ...person,
      lastMerge: {
        id: 'm1',
        mergedAt: '2026-11-11T11:00:00.000Z',
        contacts: 2,
      },
    };
    mockApi({
      personDetail: withMerge,
      unmergeResult: new ApiError(409, 'UNMERGE_BLOCKED'),
    });
    renderPage();
    const note = await screen.findByTestId('person-last-merge');
    expect(note).toHaveTextContent('lastMerge:date:2');
    fireEvent.click(within(note).getByTestId('person-unmerge'));
    expect(within(note).getByTestId('confirm-dialog')).toBeVisible();
    fireEvent.click(within(note).getByTestId('confirm-accept'));
    expect(await screen.findByTestId('person-unmerge-error')).toHaveTextContent(
      'unmerge-blocked',
    );
  });

  it('unmerge success invalidates keys and hides flow on refetch', async () => {
    const withMerge: PersonDetail = {
      ...person,
      lastMerge: {
        id: 'm1',
        mergedAt: '2026-11-11T11:00:00.000Z',
        contacts: 2,
      },
    };
    mockApi({ personDetail: withMerge });
    const { client } = renderPage();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const note = await screen.findByTestId('person-last-merge');
    fireEvent.click(within(note).getByTestId('person-unmerge'));
    fireEvent.click(within(note).getByTestId('confirm-accept'));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith('/api/v1/people/person-1/unmerge', {
        method: 'POST',
      }),
    );
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith('unmerged'));
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: ['person', 'person-1'],
      }),
    );
  });

  it('hides unmerge for non-ADMIN/OWNER', async () => {
    currentRole = 'OPERATOR';
    const withMerge: PersonDetail = {
      ...person,
      lastMerge: {
        id: 'm1',
        mergedAt: '2026-11-11T11:00:00.000Z',
        contacts: 2,
      },
    };
    mockApi({ personDetail: withMerge });
    renderPage();
    await screen.findByTestId('person-header');
    expect(screen.queryByTestId('person-last-merge')).toBeNull();
  });

  it('shows erase action per contact only for OWNER and erases with toast/invalidation', async () => {
    mockApi();
    const { client } = renderPage();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const contactCard = await screen.findByTestId('person-contact');
    fireEvent.click(within(contactCard).getByTestId('person-contact-erase'));
    expect(within(contactCard).getByTestId('confirm-dialog')).toBeVisible();
    fireEvent.click(within(contactCard).getByTestId('confirm-accept'));

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
    mockApi();
    renderPage();
    await screen.findByTestId('person-contact');
    expect(screen.queryByTestId('person-contact-erase')).toBeNull();
  });

  it('renders 404 state', async () => {
    vi.mocked(api).mockImplementation((path: string) => {
      if (path === '/api/v1/people/person-1')
        return Promise.reject(new ApiError(404, 'NOT_FOUND'));
      if (path === '/api/v1/people/person-1/duplicates')
        return Promise.resolve({ items: [] });
      return Promise.reject(new Error(`unexpected ${path}`));
    });
    renderPage();
    expect(await screen.findByTestId('person-not-found')).toBeInTheDocument();
    expect(screen.getByText('people.notFound')).toBeInTheDocument();
  });

  it('shows erase person button only for OWNER with dialog text and counts', async () => {
    mockApi();
    renderPage();
    const btn = await screen.findByTestId('person-erase');
    fireEvent.click(btn);
    const header = screen.getByTestId('person-header');
    const dialog = within(header).getByTestId('confirm-dialog');
    expect(dialog).toBeVisible();
    expect(dialog).toHaveTextContent('erase-person-body:Ada Lovelace:1:1');
  });

  it('hides erase person button for non-OWNER roles', async () => {
    currentRole = 'ADMIN';
    mockApi();
    renderPage();
    await screen.findByTestId('person-header');
    expect(screen.queryByTestId('person-erase')).toBeNull();

    cleanup();
    currentRole = 'VIEWER';
    mockApi();
    renderPage();
    await screen.findByTestId('person-header');
    expect(screen.queryByTestId('person-erase')).toBeNull();
  });

  it('cancel erase person dialog does not call API', async () => {
    mockApi();
    renderPage();
    const btn = await screen.findByTestId('person-erase');
    fireEvent.click(btn);
    const header = screen.getByTestId('person-header');
    fireEvent.click(within(header).getByTestId('confirm-cancel'));
    expect(
      vi
        .mocked(api)
        .mock.calls.some(
          (c) =>
            c[0] === '/api/v1/people/person-1' && c[1]?.method === 'DELETE',
        ),
    ).toBe(false);
  });

  it('erase person success calls DELETE, invalidates and navigates', async () => {
    const result: PersonErasureResult = {
      personId: 'person-1',
      contacts: 1,
      conversations: 1,
      messagesRedacted: 3,
    };
    vi.mocked(api).mockImplementation(
      (path: string, options?: { method?: string }) => {
        if (path === '/api/v1/people/person-1' && !options?.method)
          return Promise.resolve(person);
        if (path === '/api/v1/people/person-1/duplicates')
          return Promise.resolve({ items: [] });
        if (path === '/api/v1/people/person-1' && options?.method === 'DELETE')
          return Promise.resolve(result);
        return Promise.reject(new Error(`unexpected ${path}`));
      },
    );
    const { client } = renderPage();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const header = await screen.findByTestId('person-header');
    fireEvent.click(within(header).getByTestId('person-erase'));
    fireEvent.click(within(header).getByTestId('confirm-accept'));
    await waitFor(() => {
      expect(api).toHaveBeenCalledWith('/api/v1/people/person-1', {
        method: 'DELETE',
      });
    });
    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith('person-erased:1'),
    );
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['people'] }),
    );
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['person'] }),
    );
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: ['person-duplicates'],
      }),
    );
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['conversations'] }),
    );
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/contacts'));
  });

  it('shows inline error on person erase 403 and keeps dialog', async () => {
    vi.mocked(api).mockImplementation(
      (path: string, options?: { method?: string }) => {
        if (path === '/api/v1/people/person-1' && !options?.method)
          return Promise.resolve(person);
        if (path === '/api/v1/people/person-1/duplicates')
          return Promise.resolve({ items: [] });
        if (path === '/api/v1/people/person-1' && options?.method === 'DELETE')
          return Promise.reject(new ApiError(403, 'FORBIDDEN'));
        return Promise.reject(new Error(`unexpected ${path}`));
      },
    );
    renderPage();
    const header = await screen.findByTestId('person-header');
    fireEvent.click(within(header).getByTestId('person-erase'));
    fireEvent.click(within(header).getByTestId('confirm-accept'));
    expect(await screen.findByTestId('person-erase-error')).toHaveTextContent(
      'errors.FORBIDDEN',
    );
    expect(within(header).getByTestId('confirm-dialog')).toBeVisible();
  });
});
