import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { STAGES, makeLead } from '@/test-fixtures/leads';
import type { LeadPipelineItem } from '@/lib/types';
import { LeadPage } from './lead-page';

const state = vi.hoisted(() => ({
  role: 'OWNER',
  lead: null as unknown,
}));

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, values?: Record<string, string | number>) =>
      values ? `${key}|${Object.values(values).join(',')}` : key,
    formatDateTime: (v: string) => v,
  }),
}));
vi.mock('./app-shell', () => ({
  useShell: () => ({
    operator: { id: 'op1', role: state.role },
    timeZone: 'UTC',
  }),
}));
vi.mock('./ui/toast', () => ({ useToast: () => vi.fn() }));
vi.mock('@/lib/api', () => ({
  api: vi.fn(),
  errorKey: () => 'errors.UNKNOWN',
}));
vi.mock('./conversation-view', () => ({
  ConversationViewPane: (p: { embedded?: boolean }) => (
    <div data-testid="stub-chat" data-embedded={String(p.embedded)} />
  ),
}));
vi.mock('./lead-tasks', () => ({
  LeadTasks: () => <div data-testid="stub-tasks" />,
}));
vi.mock('./lead-timeline', () => ({
  LeadTimeline: () => <div data-testid="stub-history" />,
}));
vi.mock('./lead-opportunity', () => ({
  LeadOpportunity: () => <div data-testid="stub-opportunity" />,
}));
vi.mock('./move-to-pipeline', () => ({
  MoveToPipeline: () => <div data-testid="stub-move" />,
}));
vi.mock('./lead-tags-fields', () => ({
  LeadTagsEditor: () => <div data-testid="stub-tags" />,
}));
vi.mock('./lead-archive-button', () => ({
  LeadArchiveButton: () => <div data-testid="stub-archive" />,
}));
vi.mock('./lead-notes', () => ({
  LeadNotes: () => <div data-testid="stub-notes" />,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  state.role = 'OWNER';
});

function show(lead: LeadPipelineItem) {
  vi.mocked(api).mockImplementation((url: string) => {
    if (url.endsWith(`/leads/${lead.id}`)) return Promise.resolve(lead);
    if (url.includes('/board')) return Promise.resolve({ stages: STAGES });
    if (url.includes('/custom-fields?'))
      return Promise.resolve({
        items: [
          {
            id: 'd1',
            entity: 'LEAD',
            key: 'budget',
            label: 'Budget',
            type: 'TEXT',
            options: null,
            position: 0,
          },
        ],
      });
    return Promise.resolve({ items: [], operators: [] });
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <LeadPage leadId={lead.id} />
    </QueryClientProvider>,
  );
}

const withField = (over: Partial<LeadPipelineItem> = {}): LeadPipelineItem =>
  makeLead({
    customFields: [
      { key: 'budget', label: 'Budget', type: 'TEXT', value: '5000' },
    ],
    ...over,
  });

describe('LeadPage', () => {
  it('renders the card sections and the chat tab by default', async () => {
    show(withField());
    expect(await screen.findByTestId('lead-page')).toBeTruthy();
    expect(screen.getByTestId('lead-page-back').getAttribute('href')).toContain(
      'pipeline=',
    );
    expect(screen.getByTestId('lead-responsible')).toBeTruthy();
    expect(screen.getByTestId('lead-panel-stages')).toBeTruthy();
    const input = screen.getByTestId('lead-info-input') as HTMLInputElement;
    expect(input.value).toBe('5000');
    expect(input.disabled).toBe(false);
    const chat = await screen.findByTestId('stub-chat');
    expect(chat.getAttribute('data-embedded')).toBe('true');
  });

  it('switches between chat, notes, tasks and history', async () => {
    show(withField());
    await screen.findByTestId('lead-page');
    fireEvent.click(screen.getByTestId('lead-tab-notes'));
    expect(screen.getByTestId('stub-notes')).toBeTruthy();
    fireEvent.click(screen.getByTestId('lead-tab-tasks'));
    expect(screen.getByTestId('stub-tasks')).toBeTruthy();
    fireEvent.click(screen.getByTestId('lead-tab-history'));
    expect(screen.getByTestId('stub-history')).toBeTruthy();
    fireEvent.click(screen.getByTestId('lead-tab-chat'));
    expect(screen.getByTestId('stub-chat')).toBeTruthy();
  });

  it('a hand-added lead has no chat and opens on notes', async () => {
    const lead = withField();
    lead.conversation = { ...lead.conversation, channelType: 'manual' };
    show(lead);
    await screen.findByTestId('lead-page');
    expect(screen.getByTestId('stub-notes')).toBeTruthy();
    expect(screen.queryByTestId('lead-panel-conversation')).toBeNull();
    fireEvent.click(screen.getByTestId('lead-tab-chat'));
    expect(screen.getByTestId('lead-chat-none')).toBeTruthy();
    expect(screen.queryByTestId('stub-chat')).toBeNull();
  });

  it('shows "Add field" only to OWNER and ADMIN', async () => {
    for (const [role, visible] of [
      ['OWNER', true],
      ['ADMIN', true],
      ['OPERATOR', false],
      ['VIEWER', false],
    ] as const) {
      state.role = role;
      const view = show(withField());
      await screen.findByTestId('lead-page');
      expect(screen.queryByTestId('lead-add-field') !== null).toBe(visible);
      view.unmount();
    }
  });

  it('creates a LEAD field definition through the custom-fields API', async () => {
    show(withField());
    fireEvent.click(await screen.findByTestId('lead-add-field'));
    fireEvent.change(screen.getByTestId('lead-add-field-label'), {
      target: { value: 'Group size' },
    });
    fireEvent.click(screen.getByTestId('lead-add-field-submit'));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith('/api/v1/custom-fields', {
        method: 'POST',
        body: {
          entity: 'LEAD',
          key: 'group_size',
          label: 'Group size',
          type: 'TEXT',
        },
      }),
    );
  });

  it('saves a field when it loses focus', async () => {
    show(withField());
    const input = (await screen.findByTestId(
      'lead-info-input',
    )) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '7000' } });
    fireEvent.blur(input);
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        expect.stringContaining('/custom-fields'),
        expect.objectContaining({
          method: 'PATCH',
          body: { values: { budget: '7000' } },
        }),
      ),
    );
  });

  it('is read-only for a VIEWER', async () => {
    state.role = 'VIEWER';
    show(withField());
    await screen.findByTestId('lead-page');
    expect(
      (screen.getByTestId('lead-info-input') as HTMLInputElement).disabled,
    ).toBe(true);
    expect(screen.queryByTestId('lead-add-field')).toBeNull();
    expect(screen.queryByTestId('stub-move')).toBeNull();
    expect(screen.queryByTestId('lead-panel-ai')).toBeNull();
    expect(
      (
        (await screen.findByTestId(
          'lead-panel-stage-QUALIFIED',
        )) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it('shows the archived banner and is read-only then', async () => {
    show(withField({ archivedAt: '2026-11-01T00:00:00Z' }));
    expect(await screen.findByTestId('lead-page-archived')).toBeTruthy();
    expect(
      (screen.getByTestId('lead-info-input') as HTMLInputElement).disabled,
    ).toBe(true);
    expect(screen.queryByTestId('stub-archive')).toBeNull();
  });

  it('asks for a reason when a step moves the lead to a lost stage', async () => {
    show(withField());
    await screen.findByTestId('lead-page');
    HTMLDialogElement.prototype.showModal = function () {
      this.setAttribute('open', '');
    };
    fireEvent.click(await screen.findByTestId('lead-panel-stage-LOST'));
    expect(await screen.findByTestId('lead-lost-dialog')).toBeTruthy();
  });

  it('moves the lead to another stage with the exact PATCH body', async () => {
    show(withField());
    fireEvent.click(await screen.findByTestId('lead-panel-stage-QUALIFIED'));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith('/api/v1/leads/lead-1/stage', {
        method: 'PATCH',
        body: { stageId: 'stage-qual' },
      }),
    );
  });
});
