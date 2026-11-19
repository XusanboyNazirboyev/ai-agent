import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
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
import { api } from '@/lib/api';
import type { BoardStageView } from '@/lib/types';
import { LeadsImportDialog } from './leads-import-dialog';

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, values?: Record<string, string | number>) =>
      values ? `${key}|${Object.values(values).join(',')}` : key,
  }),
}));
vi.mock('@/lib/api', () => ({
  api: vi.fn(),
  errorKey: () => 'errors.UNKNOWN',
}));
vi.mock('@/lib/lead-fields', () => ({ LEAD_AMOUNT_ENABLED: false }));
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

const stage = (
  id: string,
  kind: BoardStageView['kind'],
  position: number,
): BoardStageView => ({
  id,
  code: null,
  name: id,
  kind,
  position,
  count: 0,
  totals: [],
});
const STAGES = [
  stage('new', 'OPEN', 0),
  stage('mid', 'OPEN', 1),
  stage('won', 'WON', 2),
];

function renderDialog(onClose = vi.fn()) {
  const client = new QueryClient();
  const spy = vi.spyOn(client, 'invalidateQueries');
  render(
    <QueryClientProvider client={client}>
      <LeadsImportDialog
        open
        pipelineId="pipe-1"
        stages={STAGES}
        onClose={onClose}
      />
    </QueryClientProvider>,
  );
  return { spy, onClose };
}

async function pick(text: string, size?: number) {
  const file = new File([text], 'leads.csv', { type: 'text/csv' });
  if (size !== undefined) Object.defineProperty(file, 'size', { value: size });
  fireEvent.change(screen.getByTestId('leads-import-file'), {
    target: { files: [file] },
  });
}

beforeEach(() => vi.mocked(api).mockReset());
afterEach(cleanup);

describe('LeadsImportDialog', () => {
  it('detects columns, shows a preview and offers open stages only', async () => {
    renderDialog();
    await pick('Ism;Telefon;Izoh\nAli;+998901112233;hi\nBek;;');
    await screen.findByTestId('leads-import-preview');
    expect(screen.getByTestId('leads-import-map-name')).toHaveValue('0');
    expect(screen.getByTestId('leads-import-map-phone')).toHaveValue('1');
    expect(screen.getByTestId('leads-import-map-note')).toHaveValue('2');
    expect(screen.getByTestId('leads-import-map-source')).toHaveValue('-1');
    expect(screen.queryByTestId('leads-import-map-amount')).toBeNull();
    const options = within(screen.getByTestId('leads-import-stage'))
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(options).toEqual(['new', 'mid']);
    expect(screen.getByTestId('leads-import-submit')).toHaveTextContent(
      'leadsImport.submit|2',
    );
  });

  it('requires the name column', async () => {
    renderDialog();
    await pick('a,b\n1,2');
    await screen.findByTestId('leads-import-preview');
    expect(screen.getByTestId('leads-import-submit')).toBeDisabled();
    fireEvent.change(screen.getByTestId('leads-import-map-name'), {
      target: { value: '0' },
    });
    expect(screen.getByTestId('leads-import-submit')).toBeEnabled();
  });

  it('rejects a file over 2 MB', async () => {
    renderDialog();
    await pick('name\nAli', 2 * 1024 * 1024 + 1);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'leadsImport.fileTooLarge',
    );
    expect(screen.queryByTestId('leads-import-preview')).toBeNull();
  });

  it('sends chunks of 200, maps skipped rows to file rows and refreshes lists', async () => {
    const rows = Array.from(
      { length: 250 },
      (_, i) => `Name ${i},9015${String(i).padStart(6, '0')}`,
    );
    vi.mocked(api)
      .mockResolvedValueOnce({
        created: 199,
        skipped: [{ row: 4, code: 'DUPLICATE' }],
      })
      .mockResolvedValueOnce({
        created: 49,
        skipped: [{ row: 0, code: 'INVALID_VALUE' }],
      });
    const { spy } = renderDialog();
    await pick(`name,phone\n${rows.join('\n')}`);
    await screen.findByTestId('leads-import-preview');
    fireEvent.click(screen.getByTestId('leads-import-submit'));
    const result = await screen.findByTestId('leads-import-result');
    expect(result).toHaveTextContent('leadsImport.done|248');
    const calls = vi.mocked(api).mock.calls;
    expect(calls).toHaveLength(2);
    const bodies = calls.map(
      (c) =>
        (
          c[1] as {
            body: { rows: unknown[]; stageId: string; pipelineId: string };
          }
        ).body,
    );
    expect(bodies.map((b) => b.rows.length)).toEqual([200, 50]);
    expect(bodies[0]).toMatchObject({ stageId: 'new', pipelineId: 'pipe-1' });
    const list = screen.getByTestId('leads-import-skipped');
    // index 4 -> file row 6; second chunk index 0 -> 200 + 0 + 2.
    expect(list).toHaveTextContent(
      'leadsImport.skippedRow|6,leadsImport.reason.DUPLICATE',
    );
    expect(list).toHaveTextContent(
      'leadsImport.skippedRow|202,leadsImport.reason.INVALID_VALUE',
    );
    await waitFor(() => {
      const keys = spy.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));
      expect(keys).toEqual(
        expect.arrayContaining(['["board"]', '["leads"]', '["pipelines"]']),
      );
    });
  });

  it('shows the error and keeps the form when the first request fails', async () => {
    vi.mocked(api).mockRejectedValueOnce(new Error('x'));
    renderDialog();
    await pick('name\nAli');
    await screen.findByTestId('leads-import-preview');
    fireEvent.click(screen.getByTestId('leads-import-submit'));
    expect(await screen.findByText('errors.UNKNOWN')).toBeInTheDocument();
    expect(screen.getByTestId('leads-import-submit')).toBeEnabled();
  });
});
