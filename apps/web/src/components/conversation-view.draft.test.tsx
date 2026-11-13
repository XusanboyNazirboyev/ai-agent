import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { ConversationViewPane } from './conversation-view';

const toastMock = vi.fn();

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, _values?: Record<string, unknown>) => {
      if (key === 'view.back') return 'Back';
      if (key === 'view.noMessages') return 'No messages';
      if (key === 'view.timeline') return 'Timeline';
      if (key === 'action.canned') return 'Canned';
      if (key === 'action.cannedNone') return 'None';
      if (key === 'action.replyPlaceholder') return 'Reply…';
      if (key === 'action.sending') return 'Sending…';
      if (key === 'action.reply') return 'Reply';
      if (key === 'view.readOnly') return 'Read only';
      if (key.startsWith('errors.')) return key;
      if (key.startsWith('state.')) return key;
      if (key.startsWith('author.')) return key;
      if (key.startsWith('delivery.')) return key;
      if (key.startsWith('voice.')) return key;
      if (key.startsWith('comment.')) return key;
      if (key.startsWith('canned.')) return key;
      if (key.startsWith('score.')) return key;
      if (key.startsWith('leadStatus.')) return key;
      if (key.startsWith('view.')) return key;
      if (key.startsWith('action.')) return key;
      if (key.startsWith('confirm.')) return key;
      if (key === 'app.loading') return 'Loading...';
      if (key === 'app.retry') return 'Retry';
      return key;
    },
    formatDateTime: () => 'date',
  }),
}));

vi.mock('./app-shell', () => ({
  useShell: () => ({
    operator: { id: 'op1', displayName: 'Op', role: 'OPERATOR' },
    timeZone: 'UTC',
  }),
}));

vi.mock('./ui/toast', () => ({
  useToast: () => toastMock,
}));

vi.mock('./actions-panel', () => ({
  ActionsPanel: () => null,
}));

vi.mock('./lead-tags-fields', () => ({
  LeadCustomFieldsEditor: () => null,
  LeadTagsEditor: () => null,
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

const conversationA = {
  id: 'conv-a',
  conversation: {
    state: 'OPERATOR_ACTIVE',
    assignedOperatorId: 'op1',
  },
  language: 'en',
  script: null,
  version: 1,
  contact: { name: 'Customer A', phone: '+998901234567' },
  handover: {
    id: 'handover-a',
    reasonCode: 'COMPLEX',
    status: 'OPEN',
    summary: null,
    slaDueAt: null,
    openedAt: '2026-11-11T10:00:00.000Z',
  },
  lead: {
    id: 'lead-a',
    score: 'HOT',
    scoreSetByOperator: false,
    status: 'NEW',
    summary: '',
    crmSyncStatus: 'NOT_REQUIRED',
  },
  messages: [],
  shownOffers: [],
  quotes: [],
  slots: [],
  notes: [],
};

const conversationB = {
  ...conversationA,
  id: 'conv-b',
  contact: { name: 'Customer B', phone: '+998901234568' },
  handover: { ...conversationA.handover, id: 'handover-b' },
};

let sendResolve: (value: unknown) => void = () => {};

function renderPane(id: string): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ConversationViewPane
        id={id}
        me={{ id: 'op1', role: 'OPERATOR' }}
        onBack={vi.fn()}
      />
    </QueryClientProvider>,
  );
}

function mockApiFor(
  opts: {
    conversationA?: unknown;
    conversationB?: unknown;
    sendResult?: unknown | Error;
  } = {},
): void {
  vi.mocked(api).mockImplementation(
    (path: string, options?: { method?: string; body?: unknown }) => {
      if (path === '/api/v1/inbox/conversations/conv-a' && !options?.method)
        return Promise.resolve(opts.conversationA ?? conversationA);
      if (path === '/api/v1/inbox/conversations/conv-b' && !options?.method)
        return Promise.resolve(opts.conversationB ?? conversationB);
      if (path.startsWith('/api/v1/handovers/') && options?.method === 'POST') {
        if (opts.sendResult instanceof Error)
          return Promise.reject(opts.sendResult);
        return new Promise((resolve) => {
          sendResolve = (value: unknown) => resolve(value);
        });
      }
      return Promise.reject(new Error(`unexpected ${path}`));
    },
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  sendResolve = () => {};
});

describe('ConversationView draft ownership (AUD-11)', () => {
  it('keeps B draft when A send resolves after id switched to B', async () => {
    mockApiFor();
    renderPane('conv-a');
    await screen.findByTestId('reply-input');

    // Start typing in A, then send (POST stays pending)
    fireEvent.change(screen.getByTestId('reply-input'), {
      target: { value: 'draft A' },
    });
    fireEvent.click(screen.getByTestId('send-reply'));

    // Switch the conversation id to B
    cleanup();
    renderPane('conv-b');
    await screen.findByTestId('reply-input');

    // Type a draft in B
    fireEvent.change(screen.getByTestId('reply-input'), {
      target: { value: 'draft B' },
    });
    expect(screen.getByTestId('reply-input')).toHaveValue('draft B');

    // Resolve A's pending POST
    sendResolve({ ok: true });

    // B's draft must still be there (not cleared by A's resolution)
    await waitFor(() => {
      expect(screen.getByTestId('reply-input')).toHaveValue('draft B');
    });
  });

  it('clears draft when send resolves in the same conversation', async () => {
    mockApiFor();
    renderPane('conv-a');
    await screen.findByTestId('reply-input');

    fireEvent.change(screen.getByTestId('reply-input'), {
      target: { value: 'draft A' },
    });
    fireEvent.click(screen.getByTestId('send-reply'));

    await waitFor(() => {
      expect(api).toHaveBeenCalledWith(
        '/api/v1/handovers/handover-a/reply',
        expect.objectContaining({ method: 'POST', body: { text: 'draft A' } }),
      );
    });
  });
});
