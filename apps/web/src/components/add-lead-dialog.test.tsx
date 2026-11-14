import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { AddLeadDialog } from './add-lead-dialog';
import type { BoardStageView } from '@/lib/types';

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, values?: Record<string, string | number>) =>
      values ? `${key}|${Object.values(values).join(',')}` : key,
    formatDateTime: () => 'date',
  }),
}));
vi.mock('./app-shell', () => ({
  useShell: () => ({
    operator: { id: 'op1', displayName: 'Op', role: 'OWNER' },
    timeZone: 'UTC',
  }),
}));
vi.mock('./ui/toast', () => ({ useToast: () => vi.fn() }));
vi.mock('@/lib/api', () => ({
  api: vi.fn(),
  errorKey: (e: unknown) =>
    `errors.${(e as { code?: string })?.code ?? 'UNKNOWN'}`,
}));
vi.mock('@/lib/lead-fields', () => ({ LEAD_AMOUNT_ENABLED: false }));
vi.mock('@/lib/currencies', () => ({
  CURRENCIES: ['UZS', 'USD'],
  parseAmount: (v: string) => v || null,
  readLastCurrency: () => null,
  rememberLastCurrency: vi.fn(),
}));
vi.mock('./ui/fields', () => ({ fieldClass: () => 'field' }));
vi.mock('./lead-board-utils', () => ({
  stageLabel: (s: { code: string | null; name: string | null }) =>
    s.name ?? s.code ?? '',
}));

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal(): void {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(): void {
    this.removeAttribute('open');
  };
});

const OPEN_STAGE: BoardStageView = {
  id: 'stage-new',
  code: 'NEW',
  name: 'New',
  kind: 'OPEN',
  position: 0,
  count: 0,
  totals: [],
};
const CLOSED_STAGE: BoardStageView = {
  id: 'stage-won',
  code: 'WON',
  name: 'Won',
  kind: 'WON',
  position: 2,
  count: 0,
  totals: [],
};

let createShouldFail = false;

vi.mocked(api).mockImplementation((path: string, options?: unknown) => {
  const opts = options as { method?: string; body?: unknown } | undefined;
  if (path === '/api/v1/team') return Promise.resolve({ operators: [] });
  if (path === '/api/v1/leads' && opts?.method === 'POST') {
    if (createShouldFail)
      return Promise.reject({
        status: 400,
        code: 'INVALID_VALUE',
        i18nKey: 'errors.INVALID_VALUE',
      });
    return Promise.resolve({ id: 'lead-2' });
  }
  return Promise.resolve({});
});

function renderDialog(
  open = true,
  pipelineId = 'pipe-1',
  stages: BoardStageView[] = [OPEN_STAGE],
  stageId: string | null = 'stage-new',
  onClose = vi.fn(),
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <AddLeadDialog
        open={open}
        pipelineId={pipelineId}
        stages={stages}
        stageId={stageId}
        onClose={onClose}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(api).mockReset();
  createShouldFail = false;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('AddLeadDialog', () => {
  it('submit is disabled with a blank name and enabled with a name', async () => {
    renderDialog();
    await screen.findByTestId('lead-add-dialog');
    const submit = screen.getByTestId('lead-add-submit');
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByTestId('lead-add-name'), {
      target: { value: 'Ada' },
    });
    expect(submit).not.toBeDisabled();
  });

  it('submits the exact body: trimmed name, pipelineId, stageId, no empty keys', async () => {
    renderDialog();
    await screen.findByTestId('lead-add-dialog');
    fireEvent.change(screen.getByTestId('lead-add-name'), {
      target: { value: '  Walk-in  ' },
    });
    fireEvent.click(screen.getByTestId('lead-add-submit'));
    await waitFor(() => expect(api).toHaveBeenCalledTimes(1));
    expect(api).toHaveBeenCalledWith('/api/v1/leads', {
      method: 'POST',
      body: {
        name: 'Walk-in',
        pipelineId: 'pipe-1',
        stageId: 'stage-new',
        ownerOperatorId: 'op1',
      },
    });
  });

  it('stage select offers only OPEN stages and preselects the stageId prop', async () => {
    renderDialog(true, 'pipe-1', [OPEN_STAGE, CLOSED_STAGE], 'stage-new');
    await screen.findByTestId('lead-add-dialog');
    const select = screen.getByTestId('lead-add-stage');
    expect(select).toHaveValue('stage-new');
    const options = select.querySelectorAll('option');
    expect(options).toHaveLength(1);
    expect(options[0].value).toBe('stage-new');
  });

  it('stages arriving after the dialog opened select the first open stage', async () => {
    const { rerender } = renderDialog(true, 'pipe-1', [], null);
    await screen.findByTestId('lead-add-dialog');
    // No open stage yet: submit stays disabled.
    expect(screen.getByTestId('lead-add-submit')).toBeDisabled();
    // Stages arrive: the first open stage is preselected.
    rerender(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <AddLeadDialog
          open
          pipelineId="pipe-1"
          stages={[OPEN_STAGE]}
          stageId={null}
          onClose={vi.fn()}
        />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId('lead-add-stage')).toHaveValue('stage-new'),
    );
    fireEvent.change(screen.getByTestId('lead-add-name'), {
      target: { value: 'Late' },
    });
    expect(screen.getByTestId('lead-add-submit')).not.toBeDisabled();
    fireEvent.click(screen.getByTestId('lead-add-submit'));
    await waitFor(() => expect(api).toHaveBeenCalledTimes(1));
  });

  it('a 400 keeps the dialog open and shows the alert', async () => {
    createShouldFail = true;
    renderDialog();
    await screen.findByTestId('lead-add-dialog');
    fireEvent.change(screen.getByTestId('lead-add-name'), {
      target: { value: 'Bad' },
    });
    fireEvent.click(screen.getByTestId('lead-add-submit'));
    await waitFor(() => expect(api).toHaveBeenCalledTimes(1));
    // Dialog stays open after a failed submission.
    expect(screen.getByTestId('lead-add-dialog')).toBeVisible();
    expect(api).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/leads'),
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
