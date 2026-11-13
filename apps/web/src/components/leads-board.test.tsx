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
import { formatAmount } from '@/lib/currencies';
import { STAGES, makeLead } from '@/test-fixtures/leads';
import type { LeadPipelineItem } from '@/lib/types';
import { LeadsBoard } from './leads-board';

const state = vi.hoisted(() => ({
  role: 'OPERATOR',
  store: new Map<string, string>(),
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
    operator: { id: 'op1', displayName: 'Op', role: state.role },
    timeZone: 'UTC',
  }),
}));
vi.mock('./ui/toast', () => ({ useToast: () => vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams('view=funnel'),
}));
vi.mock('@/lib/api', () => ({
  api: vi.fn(),
  errorKey: () => 'errors.UNKNOWN',
}));
vi.mock('@/lib/export-csv', () => ({ downloadCsv: vi.fn() }));
vi.mock('./lead-opportunity', () => ({
  LeadOpportunity: () => <div data-testid="stub-opportunity" />,
}));
vi.mock('./move-to-pipeline', () => ({
  MoveToPipeline: () => <div data-testid="stub-move-to-pipeline" />,
}));
vi.mock('./lead-tags-fields', () => ({
  LeadTagsEditor: () => <div data-testid="stub-tags" />,
  LeadCustomFieldsEditor: () => <div data-testid="stub-fields" />,
}));

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal(): void {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(): void {
    this.removeAttribute('open');
  };
});

/** The "server": leads by id, moved by PATCH, listed by stage like the API. */
let leads: LeadPipelineItem[];
let pipelinesBody: unknown;
let failMove: boolean;
/** After a refused move the refetch never answers: only the rollback can restore the card. */
let freezeLists = false;

function setupApi(): void {
  vi.mocked(api).mockImplementation((path: string, options?: unknown) => {
    const opts = options as
      { method?: string; body?: Record<string, string> } | undefined;
    if (path === '/api/v1/pipelines') return Promise.resolve(pipelinesBody);
    if (path.startsWith('/api/v1/pipelines/pipe-1/board'))
      return Promise.resolve({ stages: STAGES });
    if (path.startsWith('/api/v1/leads?')) {
      if (freezeLists) return new Promise(() => {});
      const q = new URL(path, 'http://x').searchParams;
      const stageId = q.get('stageId');
      const items = leads.filter(
        (l) => !stageId || l.pipelineStageId === stageId,
      );
      return Promise.resolve({ items, nextCursor: null });
    }
    if (path === '/api/v1/tags')
      return Promise.resolve({
        items: [{ id: 'tag-1', name: 'VIP', color: null }],
      });
    if (path === '/api/v1/team')
      return Promise.resolve({
        operators: [
          { id: 'op-9', displayName: 'Grace Hopper', isActive: true },
        ],
      });
    const move = path.match(/^\/api\/v1\/leads\/([^/]+)\/stage$/);
    if (move && opts?.method === 'PATCH') {
      if (failMove) {
        freezeLists = true;
        return Promise.reject(new Error('nope'));
      }
      leads = leads.map((l) =>
        l.id === move[1] ? { ...l, pipelineStageId: opts.body!.stageId } : l,
      );
      return Promise.resolve({ id: move[1] });
    }
    return Promise.resolve({});
  });
}

function mount(): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <LeadsBoard />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  state.role = 'OPERATOR';
  state.store.clear();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => state.store.get(k) ?? null,
    setItem: (k: string, v: string) => void state.store.set(k, v),
  });
  leads = [makeLead()];
  failMove = false;
  freezeLists = false;
  pipelinesBody = {
    items: [{ id: 'pipe-1', name: null, position: 0, isDefault: true }],
  };
  setupApi();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

const column = (code: string) => screen.findByTestId(`lead-column-${code}`);
const patchCalls = () =>
  vi
    .mocked(api)
    .mock.calls.filter(
      ([, o]) => (o as { method?: string } | undefined)?.method === 'PATCH',
    );

describe('LeadsBoard columns', () => {
  it('shows count and one total per currency, never summed', async () => {
    mount();
    const col = await column('NEW');
    expect(within(col).getByTestId('lead-count').textContent).toBe('1');
    const totals = within(col).getAllByTestId('lead-column-total');
    expect(totals.map((t) => t.textContent)).toEqual([
      formatAmount('150000.00', 'UZS'),
      formatAmount('0.30', 'USD'),
    ]);
  });

  it('marks the top accent by stage kind', async () => {
    mount();
    expect((await column('NEW')).className).toContain('border-t-primary');
    expect((await column('WON')).className).toContain('border-t-success-fg');
    expect((await column('LOST')).className).toContain('border-t-danger');
  });

  it('keeps cards free of inline selects and deprecated calls', async () => {
    mount();
    const card = await screen.findByTestId('lead-card');
    expect(within(card).queryByRole('combobox')).toBeNull();
    expect(screen.queryByTestId('lead-card-stage')).toBeNull();
    expect(
      vi
        .mocked(api)
        .mock.calls.some(([p]) => String(p).includes('/conversations/')),
    ).toBe(false);
  });

  it('hides the pipeline switcher for a single pipeline and shows it for several', async () => {
    mount();
    await screen.findByTestId('lead-card');
    expect(
      screen.queryByRole('group', { name: 'pipelines.switcher' }),
    ).toBeNull();
    cleanup();
    pipelinesBody = {
      items: [
        { id: 'pipe-1', name: null, position: 0, isDefault: true },
        { id: 'pipe-2', name: 'Tours', position: 1, isDefault: false },
      ],
    };
    mount();
    expect(
      await screen.findByRole('group', { name: 'pipelines.switcher' }),
    ).toBeInTheDocument();
  });
});

describe('LeadsBoard panel and moves', () => {
  it('opens the panel from the name button and from the card area', async () => {
    mount();
    const dialog = await screen.findByTestId('lead-panel');
    expect(dialog).not.toHaveAttribute('open');
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'leads.openLead|Ada Lovelace',
      }),
    );
    expect(dialog).toHaveAttribute('open');
    expect(
      within(dialog).getByRole('heading', { name: 'Ada Lovelace' }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('lead-panel-close'));
    expect(dialog).not.toHaveAttribute('open');
    fireEvent.click(screen.getByTestId('lead-card'));
    expect(dialog).toHaveAttribute('open');
  });

  it('closing the panel focuses the card button again', async () => {
    mount();
    const button = await screen.findByRole('button', {
      name: 'leads.openLead|Ada Lovelace',
    });
    fireEvent.click(button);
    fireEvent.click(screen.getByTestId('lead-panel-close'));
    await waitFor(() => expect(document.activeElement).toBe(button));
  });

  it('the progress bar moves the lead: exact PATCH body, card changes column', async () => {
    mount();
    fireEvent.click(await screen.findByTestId('lead-card-open'));
    fireEvent.click(screen.getByTestId('lead-panel-stage-QUALIFIED'));
    await waitFor(() => expect(patchCalls()).toHaveLength(1));
    expect(patchCalls()[0]).toEqual([
      '/api/v1/leads/lead-1/stage',
      { method: 'PATCH', body: { stageId: 'stage-qual' } },
    ]);
    await waitFor(() => {
      expect(
        within(screen.getByTestId('lead-column-NEW')).queryByTestId(
          'lead-card',
        ),
      ).toBeNull();
      expect(
        within(screen.getByTestId('lead-column-QUALIFIED')).getByTestId(
          'lead-card',
        ),
      ).toBeInTheDocument();
    });
    expect(screen.getByTestId('lead-panel-stage-QUALIFIED')).toHaveAttribute(
      'aria-current',
      'step',
    );
  });

  it('rolls the card back when the move fails', async () => {
    failMove = true;
    mount();
    fireEvent.click(await screen.findByTestId('lead-card-open'));
    fireEvent.click(screen.getByTestId('lead-panel-stage-QUALIFIED'));
    await waitFor(() => expect(patchCalls()).toHaveLength(1));
    await waitFor(() =>
      expect(
        within(screen.getByTestId('lead-column-NEW')).getByTestId('lead-card'),
      ).toBeInTheDocument(),
    );
    expect(
      within(screen.getByTestId('lead-column-QUALIFIED')).queryByTestId(
        'lead-card',
      ),
    ).toBeNull();
  });

  it('a LOST step asks for the reason first and sends it', async () => {
    mount();
    fireEvent.click(await screen.findByTestId('lead-card-open'));
    fireEvent.click(screen.getByTestId('lead-panel-stage-LOST'));
    const dialog = await screen.findByTestId('lead-lost-dialog');
    expect(dialog).toHaveAttribute('open');
    expect(patchCalls()).toHaveLength(0);
    fireEvent.submit(dialog.querySelector('form')!);
    expect(patchCalls()).toHaveLength(0);
    fireEvent.change(within(dialog).getByLabelText('opportunity.lostReason'), {
      target: { value: '  too expensive ' },
    });
    fireEvent.submit(dialog.querySelector('form')!);
    await waitFor(() => expect(patchCalls()).toHaveLength(1));
    expect(patchCalls()[0]).toEqual([
      '/api/v1/leads/lead-1/stage',
      {
        method: 'PATCH',
        body: { stageId: 'stage-lost', lostReason: 'too expensive' },
      },
    ]);
  });

  it('cancelling the LOST dialog moves nothing', async () => {
    mount();
    fireEvent.click(await screen.findByTestId('lead-card-open'));
    fireEvent.click(screen.getByTestId('lead-panel-stage-LOST'));
    const dialog = await screen.findByTestId('lead-lost-dialog');
    fireEvent.click(within(dialog).getByText('app.cancel'));
    expect(dialog).not.toHaveAttribute('open');
    expect(patchCalls()).toHaveLength(0);
  });

  it('a VIEWER can open the panel but not move, drag or hand back', async () => {
    state.role = 'VIEWER';
    leads = [makeLead({ suggestedStageId: 'stage-qual' })];
    mount();
    expect(screen.queryByTestId('lead-card-handle')).toBeNull();
    fireEvent.click(await screen.findByTestId('lead-card-open'));
    expect(screen.getByTestId('lead-panel-stage-QUALIFIED')).toBeDisabled();
    expect(screen.queryByTestId('lead-panel-ai')).toBeNull();
    expect(screen.queryByTestId('lead-accept-suggestion')).toBeNull();
  });
});

describe('LeadsBoard collapsible final columns', () => {
  it('WON and LOST start expanded on desktop and open columns have no toggle', async () => {
    mount();
    const won = await column('WON');
    expect(won).toHaveAttribute('data-collapsed', 'false');
    expect(within(won).getByTestId('lead-column-toggle')).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(
      within(await column('NEW')).queryByTestId('lead-column-toggle'),
    ).toBeNull();
  });

  it('toggling collapses the column, hides its cards and is remembered per user', async () => {
    leads = [makeLead({ id: 'lead-w', pipelineStageId: 'stage-won' })];
    mount();
    const won = await column('WON');
    await within(won).findByTestId('lead-card');
    fireEvent.click(within(won).getByTestId('lead-column-toggle'));
    expect(won).toHaveAttribute('data-collapsed', 'true');
    expect(within(won).getByTestId('lead-column-toggle')).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(
      JSON.parse(state.store.get('agentcore.leads.collapsed.op1')!),
    ).toEqual({
      'stage-won': true,
    });
    cleanup();
    mount();
    expect(await column('WON')).toHaveAttribute('data-collapsed', 'true');
    expect(await column('LOST')).toHaveAttribute('data-collapsed', 'false');
  });
});

describe('LeadsBoard filters and views', () => {
  const leadsCalls = () =>
    vi
      .mocked(api)
      .mock.calls.map(([p]) => String(p))
      .filter((p) => p.startsWith('/api/v1/leads?'));

  it('filters through a popover, sends the contract params and shows removable chips', async () => {
    mount();
    await screen.findByTestId('lead-card');
    const button = screen.getByTestId('leads-filters-button');
    expect(screen.queryByTestId('leads-filters-count')).toBeNull();
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    await waitFor(() =>
      expect(
        screen.getByTestId('leads-tag-filter').querySelectorAll('option'),
      ).toHaveLength(2),
    );
    fireEvent.change(screen.getByTestId('leads-tag-filter'), {
      target: { value: 'tag-1' },
    });
    await waitFor(() =>
      expect(leadsCalls()).toContain(
        '/api/v1/leads?pipelineId=pipe-1&stageId=stage-new&limit=25&tagId=tag-1',
      ),
    );
    expect(screen.getByTestId('leads-filters-count').textContent).toContain(
      '1',
    );
    fireEvent.click(screen.getByTestId('leads-filter-chip-tagId'));
    expect(screen.queryByTestId('leads-filter-chips')).toBeNull();
  });

  it('manager owner filter uses ownerOperatorId; Clear all resets every filter', async () => {
    state.role = 'OWNER';
    mount();
    await screen.findByTestId('lead-card');
    fireEvent.click(screen.getByTestId('leads-filters-button'));
    const owner = await screen.findByRole('combobox', {
      name: 'leads.filterOwner',
    });
    await waitFor(() =>
      expect(owner.querySelectorAll('option')).toHaveLength(2),
    );
    fireEvent.change(owner, { target: { value: 'op-9' } });
    fireEvent.change(screen.getByLabelText('leads.filterCloseBefore'), {
      target: { value: '2026-12-31' },
    });
    await waitFor(() =>
      expect(leadsCalls()).toContain(
        '/api/v1/leads?pipelineId=pipe-1&stageId=stage-new&limit=25&ownerOperatorId=op-9&closeBefore=2026-12-31',
      ),
    );
    fireEvent.click(screen.getByTestId('leads-clear-all'));
    expect(screen.queryByTestId('leads-filter-chips')).toBeNull();
  });

  it('Escape closes the popover and focus returns to the button', async () => {
    mount();
    await screen.findByTestId('lead-card');
    const button = screen.getByTestId('leads-filters-button');
    fireEvent.click(button);
    fireEvent.keyDown(screen.getByRole('group', { name: 'leads.filters' }), {
      key: 'Escape',
    });
    expect(screen.queryByRole('group', { name: 'leads.filters' })).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('has no text search box (the API has none)', async () => {
    mount();
    await screen.findByTestId('lead-card');
    expect(screen.queryByRole('searchbox')).toBeNull();
  });

  it('the list view lists the pipeline without a stage filter and opens the panel', async () => {
    leads = [
      makeLead(),
      makeLead({ id: 'lead-2', contact: { name: 'Bob', phone: null } }),
    ];
    mount();
    await screen.findAllByTestId('lead-card');
    fireEvent.click(screen.getByRole('button', { name: 'leads.view.table' }));
    const rows = await screen.findAllByTestId('lead-list-row');
    expect(rows).toHaveLength(2);
    expect(leadsCalls()).toContain('/api/v1/leads?pipelineId=pipe-1&limit=25');
    expect(within(rows[0]).getByTestId('lead-list-stage').textContent).toBe(
      'New',
    );
    expect(within(rows[0]).getByTestId('lead-list-amount').textContent).toBe(
      formatAmount('150000.00', 'UZS'),
    );
    fireEvent.click(within(rows[1]).getByTestId('lead-list-open'));
    expect(
      within(screen.getByTestId('lead-panel')).getByRole('heading', {
        name: 'Bob',
      }),
    ).toBeInTheDocument();
  });

  it('the funnel strip is a disclosure, open by default on desktop', async () => {
    mount();
    await screen.findByTestId('lead-card');
    const toggle = screen.getByTestId('funnel-toggle');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getAllByTestId('funnel-stage')).toHaveLength(4);
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryAllByTestId('funnel-stage')).toHaveLength(0);
  });

  it('shows Export for OWNER and ADMIN only', async () => {
    mount();
    await screen.findByTestId('lead-card');
    expect(screen.queryByTestId('leads-export')).toBeNull();
    cleanup();
    state.role = 'ADMIN';
    mount();
    expect(await screen.findByTestId('leads-export')).toBeInTheDocument();
  });
});

describe('LeadsBoard created range and mobile tabs', () => {
  it('the creation range lives in Filters, goes to the board as from/to and has chips', async () => {
    mount();
    await screen.findByTestId('lead-card');
    expect(screen.queryByTestId('funnel-toggle')).toBeInTheDocument();
    // The funnel strip no longer holds date inputs.
    expect(screen.queryByLabelText('leads.funnelFrom')).toBeNull();
    fireEvent.click(screen.getByTestId('leads-filters-button'));
    fireEvent.change(screen.getByLabelText('leads.createdFrom'), {
      target: { value: '2026-11-01' },
    });
    fireEvent.change(screen.getByLabelText('leads.createdTo'), {
      target: { value: '2026-11-30' },
    });
    await waitFor(() =>
      expect(vi.mocked(api).mock.calls.map(([p]) => String(p))).toContain(
        '/api/v1/pipelines/pipe-1/board?from=2026-11-01&to=2026-11-30',
      ),
    );
    expect(
      screen.getByTestId('leads-filter-chip-createdFrom'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('leads-filter-chip-createdTo'));
    expect(screen.queryByTestId('leads-filter-chip-createdTo')).toBeNull();
    expect(screen.getByTestId('leads-filters-count').textContent).toContain(
      '1',
    );
  });

  it('below md one column shows at a time, picked from the stage tab bar', async () => {
    vi.stubGlobal('innerWidth', 375);
    mount();
    const tabs = await screen.findByTestId('leads-stage-tabs');
    expect(within(tabs).getAllByTestId('leads-stage-tab')).toHaveLength(4);
    expect(
      document.querySelectorAll('section[data-testid^="lead-column-"]'),
    ).toHaveLength(1);
    expect(screen.getByTestId('lead-column-NEW')).toBeInTheDocument();
    expect(screen.queryByTestId('lead-column-toggle')).toBeNull();
    const won = within(tabs).getByText('Won').closest('button')!;
    expect(won.className).toContain('bg-success-soft');
    fireEvent.click(won);
    expect(won).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('lead-column-WON')).toBeInTheDocument();
    expect(screen.queryByTestId('lead-column-NEW')).toBeNull();
  });
});
