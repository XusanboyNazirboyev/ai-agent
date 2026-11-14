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
import { LeadArchiveButton } from './lead-archive-button';

const toast = vi.fn();

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, values?: Record<string, string | number>) =>
      values ? `${key}|${Object.values(values).join(',')}` : key,
    formatDateTime: () => 'date',
  }),
}));
vi.mock('@/lib/api', () => ({
  api: vi.fn(),
  errorKey: (e: unknown) =>
    `errors.${(e as { code?: string })?.code ?? 'UNKNOWN'}`,
}));
vi.mock('./app-shell', () => ({
  useShell: () => ({ operator: { id: 'op1', role: 'OWNER' }, timeZone: 'UTC' }),
}));
vi.mock('./ui/toast', () => ({ useToast: () => toast }));
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

function renderButton(leadId = 'lead-1', onArchived = vi.fn()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <LeadArchiveButton leadId={leadId} onArchived={onArchived} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(api).mockReset();
  toast.mockClear();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('LeadArchiveButton', () => {
  it('opens the confirm dialog and sends nothing until confirmed', async () => {
    renderButton();
    await screen.findByTestId('lead-archive');
    fireEvent.click(screen.getByTestId('lead-archive'));
    await screen.findByTestId('confirm-stub');
    expect(api).not.toHaveBeenCalled();
  });

  it('cancelling sends nothing', async () => {
    renderButton();
    fireEvent.click(screen.getByTestId('lead-archive'));
    fireEvent.click(screen.getByTestId('confirm-cancel'));
    await waitFor(() =>
      expect(screen.queryByTestId('confirm-stub')).toBeNull(),
    );
    expect(api).not.toHaveBeenCalled();
  });

  it('confirming sends POST archive once and calls onArchived', async () => {
    const onArchived = vi.fn();
    vi.mocked(api).mockResolvedValueOnce({});
    renderButton('lead-1', onArchived);
    fireEvent.click(screen.getByTestId('lead-archive'));
    fireEvent.click(screen.getByTestId('confirm-accept'));
    await waitFor(() => expect(api).toHaveBeenCalledTimes(1));
    expect(api).toHaveBeenCalledWith('/api/v1/leads/lead-1/archive', {
      method: 'POST',
    });
    expect(onArchived).toHaveBeenCalledTimes(1);
  });

  it('a failing request shows the error toast key and does not call onArchived', async () => {
    const onArchived = vi.fn();
    vi.mocked(api).mockRejectedValueOnce(new Error('boom'));
    renderButton('lead-1', onArchived);
    fireEvent.click(screen.getByTestId('lead-archive'));
    fireEvent.click(screen.getByTestId('confirm-accept'));
    await waitFor(() => expect(api).toHaveBeenCalledTimes(1));
    expect(toast).toHaveBeenCalledWith('errors.UNKNOWN');
    expect(onArchived).not.toHaveBeenCalled();
  });
});
