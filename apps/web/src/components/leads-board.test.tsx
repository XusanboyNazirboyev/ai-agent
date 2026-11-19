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
    if (path === '/api/v1/leads/stages?pipelineId=pipe-1')
      return Promise.resolve(
        STAGES.map((stage) => ({ ...stage, pipelineId: 'pipe-1' })),
      );
    if (path === '/api/v1/leads/bulk' && opts?.method === 'POST')
      return Promise.resolve({ updated: 1, failed: [] });
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
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => state.store.get(`session:${k}`) ?? null,
    setItem: (k: string, v: string) => void state.store.set(`session:${k}`, v),
  });
  leads = [makeLead()];
  failMove = false;
  freezeLists = false;
  pipelinesBody = {
    items: [
      { id: 'pipe-1', name: null, position: 0, isDefault: true, leadCount: 1 },
    ],
  };
  setupApi();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

const column = (code: string) => screen.findByTestId(`lead-column-${code}`);
describe('LeadsBoard columns', () => {
  it('shows the count and no amount totals (the amount is hidden)', async () => {
    mount();
    const col = await column('NEW');
    expect(within(col).getByTestId('lead-count').textContent).toBe('1');
    expect(within(col).queryAllByTestId('lead-column-total')).toHaveLength(0);
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

describe('LeadsBoard opens the lead page', () => {
  it('keeps the table view after a visit to a lead page', async () => {
    mount();
    fireEvent.click(
      await screen.findByRole('button', { name: 'leads.view.table' }),
    );
    expect(state.store.get('session:leads-board-view')).toBe('list');
    cleanup();
    mount();
    await waitFor(() =>
      expect(
        screen
          .getByRole('button', { name: 'leads.view.table' })
          .getAttribute('aria-pressed'),
      ).toBe('true'),
    );
  });

  it('the card name is a real link to /leads/<id>', async () => {
    mount();
    const link = await screen.findByRole('link', {
      name: 'leads.openLead|Ada Lovelace',
    });
    expect(link.getAttribute('href')).toBe('/leads/lead-1');
    expect(link.getAttribute('data-lead-open')).toBe('lead-1');
  });

  it('a VIEWER has no drag handle but can still open the lead', async () => {
    state.role = 'VIEWER';
    leads = [makeLead({ suggestedStageId: 'stage-qual' })];
    mount();
    expect(screen.queryByTestId('lead-card-handle')).toBeNull();
    expect(
      (await screen.findByTestId('lead-card-open')).getAttribute('href'),
    ).toBe('/leads/lead-1');
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
    // Any, mine, unassigned, then the team (ADR 076).
    await waitFor(() =>
      expect(owner.querySelectorAll('option')).toHaveLength(4),
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

  it('a click outside closes the popover, and a chip click below it still lands', async () => {
    mount();
    await screen.findByTestId('lead-card');
    fireEvent.click(screen.getByTestId('leads-filters-button'));
    fireEvent.click(screen.getByTestId('leads-channel-telegram'));
    const chip = await screen.findByTestId('leads-filter-chip-channel');
    // mousedown alone no longer closes it (closing could move the page).
    fireEvent.mouseDown(chip);
    expect(screen.getByRole('group', { name: 'leads.filters' })).toBeTruthy();
    fireEvent.click(chip);
    expect(screen.queryByTestId('leads-filter-chip-channel')).toBeNull();
    expect(screen.queryByRole('group', { name: 'leads.filters' })).toBeNull();
  });

  it('searches by name or phone after a pause, in the list and the board counts (ADR 076)', async () => {
    mount();
    await screen.findByTestId('lead-card');
    fireEvent.change(screen.getByRole('searchbox'), {
      target: { value: '97 988' },
    });
    await waitFor(() =>
      expect(leadsCalls()).toContain(
        '/api/v1/leads?pipelineId=pipe-1&stageId=stage-new&limit=25&q=97+988',
      ),
    );
    expect(vi.mocked(api).mock.calls.map(([p]) => String(p))).toContain(
      '/api/v1/pipelines/pipe-1/board?q=97+988',
    );
    // The search is not a filter: no count on the Filters button.
    expect(screen.queryByTestId('leads-filters-count')).toBeNull();
  });

  it('filters by channel, score and overdue tasks with chips (ADR 076)', async () => {
    mount();
    await screen.findByTestId('lead-card');
    fireEvent.click(screen.getByTestId('leads-filters-button'));
    fireEvent.click(screen.getByTestId('leads-channel-telegram'));
    fireEvent.click(screen.getByTestId('leads-score-HOT'));
    fireEvent.click(screen.getByTestId('leads-task-overdue'));
    await waitFor(() =>
      expect(leadsCalls()).toContain(
        '/api/v1/leads?pipelineId=pipe-1&stageId=stage-new&limit=25&channel=telegram&score=HOT&task=overdue',
      ),
    );
    expect(screen.getByTestId('leads-filter-chip-channel')).toBeInTheDocument();
    expect(screen.getByTestId('leads-filters-count').textContent).toContain(
      '3',
    );
    fireEvent.click(screen.getByTestId('leads-preset-today'));
    expect(screen.getByTestId('leads-preset-today')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('the list view lists the pipeline without a stage filter and links to the lead page', async () => {
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
    expect(within(rows[0]).queryByTestId('lead-list-amount')).toBeNull();
    expect(
      within(rows[1]).getByTestId('lead-list-open').getAttribute('href'),
    ).toBe('/leads/lead-2');
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

describe('LeadsBoard counts and select mode (ADR 076)', () => {
  it("shows each pipeline's lead count, the total and the board count", async () => {
    pipelinesBody = {
      items: [
        {
          id: 'pipe-1',
          name: null,
          position: 0,
          isDefault: true,
          leadCount: 3,
        },
        {
          id: 'pipe-2',
          name: 'Tours',
          position: 1,
          isDefault: false,
          leadCount: 5,
        },
      ],
    };
    mount();
    await screen.findByTestId('lead-card');
    expect(
      screen.getAllByTestId('pipeline-switch-count').map((c) => c.textContent),
    ).toEqual(['3', '5']);
    expect(screen.getByTestId('leads-total').textContent).toContain(
      'leads.total|8',
    );
    expect(screen.getByTestId('leads-board-total').textContent).toContain(
      'leads.boardCount|',
    );
  });

  it('selects cards and moves them to a stage in one request', async () => {
    mount();
    await screen.findByTestId('lead-card');
    expect(screen.queryByTestId('lead-card-select')).toBeNull();
    fireEvent.click(screen.getByTestId('leads-select-toggle'));
    // Operators move; changing the owner of many leads is for managers.
    expect(screen.queryByTestId('leads-bulk-assign-open')).toBeNull();
    expect(screen.getByTestId('leads-bulk-move-open')).toBeDisabled();
    fireEvent.click(screen.getByTestId('lead-card-select'));
    expect(screen.getByTestId('leads-selected-count').textContent).toBe(
      'leads.selectedCount|1',
    );
    fireEvent.click(screen.getByTestId('leads-bulk-move-open'));
    const stage = await screen.findByTestId('leads-bulk-stage');
    await waitFor(() =>
      expect(stage.querySelectorAll('option').length).toBeGreaterThan(1),
    );
    fireEvent.change(stage, { target: { value: 'stage-qual' } });
    fireEvent.click(screen.getByRole('button', { name: 'leads.bulkApply' }));
    await waitFor(() =>
      expect(
        vi
          .mocked(api)
          .mock.calls.find(([p]) => p === '/api/v1/leads/bulk')?.[1],
      ).toEqual({
        method: 'POST',
        body: {
          action: 'move',
          stageId: 'stage-qual',
          leadIds: ['lead-1'],
        },
      }),
    );
    await waitFor(() =>
      expect(screen.queryByTestId('leads-bulk-bar')).toBeNull(),
    );
  });

  it('managers can select every shown lead and change the owner', async () => {
    state.role = 'ADMIN';
    leads = [makeLead(), makeLead({ id: 'lead-2' })];
    mount();
    await waitFor(() =>
      expect(screen.getAllByTestId('lead-card')).toHaveLength(2),
    );
    fireEvent.click(screen.getByTestId('leads-select-toggle'));
    fireEvent.click(screen.getByTestId('leads-select-shown'));
    expect(screen.getByTestId('leads-selected-count').textContent).toBe(
      'leads.selectedCount|2',
    );
    fireEvent.click(screen.getByTestId('leads-bulk-assign-open'));
    const owner = await screen.findByTestId('leads-bulk-owner');
    await waitFor(() =>
      expect(owner.querySelectorAll('option')).toHaveLength(3),
    );
    fireEvent.change(owner, { target: { value: 'none' } });
    fireEvent.click(screen.getByRole('button', { name: 'leads.bulkApply' }));
    await waitFor(() =>
      expect(
        vi
          .mocked(api)
          .mock.calls.find(([p]) => p === '/api/v1/leads/bulk')?.[1],
      ).toEqual({
        method: 'POST',
        body: {
          action: 'assign',
          ownerOperatorId: null,
          leadIds: ['lead-1', 'lead-2'],
        },
      }),
    );
  });

  it('viewers get no select mode', async () => {
    state.role = 'VIEWER';
    mount();
    await screen.findByTestId('lead-card');
    expect(screen.queryByTestId('leads-select-toggle')).toBeNull();
  });
});
