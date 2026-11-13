import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '@/lib/api';
import { downloadCsv } from '@/lib/export-csv';
import { ContactsPage } from './contacts-page';
import { LeadsBoard } from './leads-board';

const state = vi.hoisted(() => ({ role: 'OWNER', toast: vi.fn() }));

vi.mock('@/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key, formatDateTime: () => 'date' }),
}));
vi.mock('./app-shell', () => ({
  useShell: () => ({
    operator: { id: 'op1', displayName: 'Op', role: state.role },
    timeZone: 'UTC',
  }),
}));
// Real ApiError and errorKey; only the network call is replaced.
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/components/ui/toast', () => ({ useToast: () => state.toast }));
vi.mock('@/lib/export-csv', () => ({ downloadCsv: vi.fn() }));

const tags = { items: [{ id: 'tag-1', name: 'VIP', color: null }] };

function setupApi(): void {
  vi.mocked(api).mockImplementation((path: string) => {
    if (path === '/api/v1/tags') return Promise.resolve(tags);
    if (path === '/api/v1/leads/stages') return Promise.resolve([]);
    if (path === '/api/v1/pipelines')
      return Promise.resolve({
        items: [
          {
            id: 'p1',
            name: null,
            position: 0,
            isDefault: true,
            aiStaging: 'OFF',
            stageCount: 0,
            leadCount: 0,
          },
        ],
      });
    if (path.startsWith('/api/v1/pipelines/') && path.includes('/board'))
      return Promise.resolve({ stages: [] });
    return Promise.resolve({ items: [], nextCursor: null });
  });
}

function renderIn(node: ReactNode): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  state.role = 'OWNER';
});

const PAGES = [
  ['people', 'people-export', () => <ContactsPage />],
  ['leads', 'leads-export', () => <LeadsBoard />],
] as const;

describe.each(PAGES)('%s export button', (kind, testId, page) => {
  it.each(['OWNER', 'ADMIN'])('is shown for %s', async (role) => {
    state.role = role;
    setupApi();
    renderIn(page());
    expect(await screen.findByTestId(testId)).toBeInTheDocument();
  });

  it.each(['OPERATOR', 'VIEWER'])('is hidden for %s', async (role) => {
    state.role = role;
    setupApi();
    renderIn(page());
    await waitFor(() => expect(api).toHaveBeenCalled());
    expect(screen.queryByTestId(testId)).toBeNull();
  });

  it('is busy while downloading, then confirms with a toast', async () => {
    setupApi();
    let finish: (name: string) => void = () => undefined;
    vi.mocked(downloadCsv).mockReturnValue(
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
    );
    renderIn(page());
    const button = await screen.findByTestId(testId);
    fireEvent.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(downloadCsv).toHaveBeenCalledWith(
      `/api/v1/exports/${kind}.csv`,
      `${kind}.csv`,
    );
    finish(`${kind}.csv`);
    await waitFor(() => expect(button).toBeEnabled());
    expect(state.toast).toHaveBeenCalledWith('toast.exportStarted');
  });

  it.each([
    [413, 'EXPORT_TOO_LARGE', 'errors.EXPORT_TOO_LARGE'],
    [429, 'EXPORT_IN_PROGRESS', 'errors.EXPORT_IN_PROGRESS'],
    [403, 'FORBIDDEN', 'errors.FORBIDDEN'],
  ])('maps %i %s to the catalog key', async (status, code, key) => {
    setupApi();
    // The API answers {statusCode, message, code, i18nKey}; the key it sends
    // for FORBIDDEN is not in the catalog, so the code's own key is used.
    vi.mocked(downloadCsv).mockRejectedValue(
      new ApiError(
        status,
        code,
        code === 'FORBIDDEN' ? 'errors.forbidden' : `errors.${code}`,
      ),
    );
    renderIn(page());
    const button = await screen.findByTestId(testId);
    fireEvent.click(button);
    await waitFor(() => expect(state.toast).toHaveBeenCalledWith(key));
    expect(button).toBeEnabled();
  });

  it('passes the tag filter on', async () => {
    setupApi();
    vi.mocked(downloadCsv).mockResolvedValue('x.csv');
    renderIn(page());
    // The leads tag filter lives in the Filters popover.
    if (kind === 'leads')
      fireEvent.click(await screen.findByTestId('leads-filters-button'));
    const select = await screen.findByTestId(
      kind === 'people' ? 'people-tag-filter' : 'leads-tag-filter',
    );
    await waitFor(() =>
      expect(select.querySelectorAll('option')).toHaveLength(2),
    );
    fireEvent.change(select, { target: { value: 'tag-1' } });
    fireEvent.click(await screen.findByTestId(testId));
    expect(downloadCsv).toHaveBeenCalledWith(
      `/api/v1/exports/${kind}.csv?tagId=tag-1`,
      `${kind}.csv`,
    );
  });

  it('keeps the button from forcing a horizontal scroll at 320px', async () => {
    setupApi();
    renderIn(page());
    const button = await screen.findByTestId(testId);
    expect(button.className).toContain('min-w-0');
    expect(button.className).not.toContain('shrink-0');
    expect(button.parentElement?.className).toContain('flex-wrap');
    expect(
      Array.from(button.parentElement?.children ?? []).some((c) =>
        c.className.includes('shrink-0'),
      ),
    ).toBe(false);
  });
});

describe('people export keeps the search', () => {
  it('sends the typed search with the tag', async () => {
    setupApi();
    vi.mocked(downloadCsv).mockResolvedValue('x.csv');
    renderIn(<ContactsPage />);
    fireEvent.change(await screen.findByLabelText('people.search'), {
      target: { value: 'Ada' },
    });
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith('/api/v1/people?limit=25&q=Ada'),
    );
    fireEvent.click(screen.getByTestId('people-export'));
    expect(downloadCsv).toHaveBeenCalledWith(
      '/api/v1/exports/people.csv?q=Ada',
      'people.csv',
    );
  });
});
