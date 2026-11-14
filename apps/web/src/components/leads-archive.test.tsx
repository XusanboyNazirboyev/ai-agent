import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { LeadPipelineItem } from '@/lib/types';
import { LeadsArchive } from './leads-archive';
import { makeLead } from '@/test-fixtures/leads';

vi.mock('@/lib/api', () => ({
  api: vi.fn(),
  errorKey: (e: unknown) =>
    `errors.${(e as { code?: string })?.code ?? 'UNKNOWN'}`,
}));

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, values?: Record<string, string | number>) =>
      values ? `${key}|${Object.values(values).join(',')}` : key,
    formatDateTime: () => 'date',
  }),
}));
vi.mock('./app-shell', () => ({
  useShell: () => ({
    operator: { id: 'op1', role: state.role },
    timeZone: 'UTC',
  }),
}));
vi.mock('./ui/toast', () => ({ useToast: () => vi.fn() }));
vi.mock('./ui/avatar', () => ({
  Avatar: ({ name }: { name: string }) => (
    <span data-testid="avatar">{name}</span>
  ),
}));
vi.mock('./ui/skeleton', () => ({ SkeletonRows: () => null }));
vi.mock('./ui/confirm-dialog', () => ({
  ConfirmDialog: ({
    open,
    confirmLabel,
    cancelLabel,
    onConfirm,
    onCancel,
  }: {
    open: boolean;
    confirmLabel: string;
    cancelLabel: string;
    onConfirm: () => void;
    onCancel: () => void;
  }) =>
    open ? (
      <div data-testid="confirm-stub">
        <button data-testid="confirm-cancel" onClick={onCancel}>
          {cancelLabel}
        </button>
        <button data-testid="confirm-accept" onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    ) : null,
}));

const state = vi.hoisted(() => ({ role: 'OWNER' as 'OWNER' | 'ADMIN' }));

function renderArchive(pipelineId = 'pipe-1', items: LeadPipelineItem[] = []) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let currentItems = items;
  vi.mocked(api).mockImplementation((path: string, options?: unknown) => {
    const opts = options as { method?: string } | undefined;
    const q = new URL(path, 'http://x').searchParams;
    if (path.startsWith('/api/v1/leads') && q.get('archived') === 'true')
      return Promise.resolve({ items: currentItems, nextCursor: null });
    const restore = path.match(/^\/api\/v1\/leads\/([^/]+)\/restore$/);
    if (restore && opts?.method === 'POST')
      return Promise.resolve({ id: restore[1] });
    const del = path.match(/^\/api\/v1\/leads\/([^/]+)$/);
    if (del && opts?.method === 'DELETE') {
      currentItems = currentItems.filter((i) => i.id !== del[1]);
      return Promise.resolve({ id: del[1] });
    }
    return Promise.resolve({});
  });
  render(
    <QueryClientProvider client={client}>
      <LeadsArchive pipelineId={pipelineId} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(api).mockReset();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('LeadsArchive', () => {
  it('renders rows from the archived list', async () => {
    renderArchive('pipe-1', [
      makeLead({ id: 'lead-1', contact: { name: 'Ada', phone: null } }),
    ]);
    await screen.findByTestId('leads-archive-row');
    expect(screen.getByTestId('leads-archive-row')).toHaveTextContent('Ada');
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        expect.stringContaining('archived=true'),
      ),
    );
  });

  it('shows empty state when there are no archived leads', async () => {
    renderArchive('pipe-1', []);
    await screen.findByTestId('leads-archive-empty');
    expect(screen.queryByTestId('leads-archive-row')).toBeNull();
  });

  it('as owner each row has Restore and Delete for good', async () => {
    state.role = 'OWNER';
    renderArchive('pipe-1', [
      makeLead({ id: 'lead-1', contact: { name: 'Ada', phone: null } }),
    ]);
    await screen.findByTestId('leads-archive-row');
    expect(screen.getByTestId('lead-restore')).toBeVisible();
    expect(screen.getByTestId('lead-delete-forever')).toBeVisible();
  });

  it('as admin each row has Restore only, no Delete for good', async () => {
    state.role = 'ADMIN';
    renderArchive('pipe-1', [
      makeLead({ id: 'lead-1', contact: { name: 'Ada', phone: null } }),
    ]);
    await screen.findByTestId('leads-archive-row');
    expect(screen.getByTestId('lead-restore')).toBeVisible();
    expect(screen.queryByTestId('lead-delete-forever')).toBeNull();
  });

  it('restore sends POST .../restore', async () => {
    state.role = 'OWNER';
    renderArchive('pipe-1', [
      makeLead({ id: 'lead-1', contact: { name: 'Ada', phone: null } }),
    ]);
    await screen.findByTestId('leads-archive-row');
    fireEvent.click(screen.getByTestId('lead-restore'));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        '/api/v1/leads/lead-1/restore',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
  });

  it('delete for good: asks first, Cancel sends nothing, confirm deletes and refreshes', async () => {
    state.role = 'OWNER';
    renderArchive('pipe-1', [
      makeLead({ id: 'lead-1', contact: { name: 'Ada', phone: null } }),
    ]);
    await screen.findByTestId('leads-archive-row');
    fireEvent.click(screen.getByTestId('lead-delete-forever'));
    await screen.findByTestId('confirm-stub');
    expect(api).not.toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/v1\/leads\/lead-1$/),
      expect.objectContaining({ method: 'DELETE' }),
    );
    fireEvent.click(screen.getByTestId('confirm-cancel'));
    await waitFor(() =>
      expect(screen.queryByTestId('confirm-stub')).toBeNull(),
    );
    expect(api).not.toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/v1\/leads\/lead-1$/),
      expect.objectContaining({ method: 'DELETE' }),
    );
    expect(screen.getByTestId('leads-archive-row')).toBeVisible();

    fireEvent.click(screen.getByTestId('lead-delete-forever'));
    await screen.findByTestId('confirm-stub');
    fireEvent.click(screen.getByTestId('confirm-accept'));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        '/api/v1/leads/lead-1',
        expect.objectContaining({ method: 'DELETE' }),
      ),
    );
    await waitFor(() =>
      expect(screen.queryByTestId('leads-archive-row')).toBeNull(),
    );
  });
});
