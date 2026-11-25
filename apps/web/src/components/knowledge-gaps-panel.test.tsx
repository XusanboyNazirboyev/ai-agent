import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { KnowledgeGapsPanel } from './knowledge-gaps-panel';

let role = 'OWNER';
vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    formatDateTime: () => 'date',
  }),
}));
vi.mock('./ui/toast', () => ({ useToast: () => vi.fn() }));
vi.mock('./app-shell', () => ({
  useShell: () => ({ operator: { id: 'op1', role }, timeZone: 'UTC' }),
}));
vi.mock('@/lib/api', () => ({
  api: vi.fn(),
  errorKey: () => 'errors.UNKNOWN',
}));

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal(): void {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close(): void {
    this.open = false;
  };
});

function view(node: ReactNode): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

afterEach(() => {
  cleanup();
  vi.mocked(api).mockReset();
  role = 'OWNER';
});

const gap = {
  ids: ['t1', 't2'],
  question: 'Yetkazib berish bormi?',
  count: 2,
  lastAskedAt: '2026-11-24T10:00:00Z',
  conversationId: 'c1',
};

function serve(): void {
  vi.mocked(api).mockImplementation(async (path, init) => {
    if (path === '/api/v1/knowledge/gaps') return { items: [gap] } as never;
    if (path === '/api/v1/knowledge/faq' && !init)
      return { limits: { question: 200, answer: 600 }, items: [] } as never;
    return {} as never;
  });
}

describe('unanswered questions (ADR 091)', () => {
  it('answers with a FAQ entry, then marks the question answered', async () => {
    serve();
    view(<KnowledgeGapsPanel />);
    fireEvent.click(await screen.findByTestId('gap-answer'));
    expect((screen.getByTestId('faq-question') as HTMLInputElement).value).toBe(
      'Yetkazib berish bormi?',
    );
    fireEvent.change(screen.getByTestId('faq-answer'), {
      target: { value: 'Ha, Toshkent bo‘ylab.' },
    });
    fireEvent.click(screen.getByTestId('faq-consent'));
    fireEvent.click(screen.getByTestId('faq-save'));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith('/api/v1/knowledge/gaps/resolve', {
        method: 'POST',
        body: { ids: ['t1', 't2'], resolution: 'ANSWERED' },
      }),
    );
    const calls = vi
      .mocked(api)
      .mock.calls.map(([path, init]) => [path, init?.method]);
    const faqPost = calls.findIndex(
      ([path, method]) => path === '/api/v1/knowledge/faq' && method === 'POST',
    );
    const resolve = calls.findIndex(
      ([path]) => path === '/api/v1/knowledge/gaps/resolve',
    );
    expect(faqPost).toBeGreaterThanOrEqual(0);
    expect(faqPost).toBeLessThan(resolve);
  });

  it('dismisses a question without a FAQ entry', async () => {
    serve();
    view(<KnowledgeGapsPanel />);
    fireEvent.click(await screen.findByTestId('gap-dismiss'));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith('/api/v1/knowledge/gaps/resolve', {
        method: 'POST',
        body: { ids: ['t1', 't2'], resolution: 'DISMISSED' },
      }),
    );
  });

  it('operators only read the list', async () => {
    role = 'OPERATOR';
    serve();
    view(<KnowledgeGapsPanel />);
    expect(await screen.findByText('Yetkazib berish bormi?')).toBeTruthy();
    expect(screen.queryByTestId('gap-answer')).toBeNull();
    expect(screen.queryByTestId('gap-dismiss')).toBeNull();
  });
});
