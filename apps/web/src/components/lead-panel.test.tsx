import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { STAGES, makeLead } from '@/test-fixtures/leads';
import type { LeadPipelineItem } from '@/lib/types';
import { LeadPanel } from './lead-panel';

const state = vi.hoisted(() => ({ role: 'OPERATOR' }));

const MESSAGES: Record<string, string> = {
  'leads.reason.offer_shown': 'an offer was shown',
  'leads.reason.unknown': 'automatic rule',
};
vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, values?: Record<string, string | number>) =>
      MESSAGES[key] ??
      (values ? `${key}|${Object.values(values).join(',')}` : key),
  }),
}));
vi.mock('./app-shell', () => ({
  useShell: () => ({ operator: { id: 'op1', role: state.role } }),
}));
vi.mock('./ui/toast', () => ({ useToast: () => vi.fn() }));
vi.mock('@/lib/api', () => ({
  api: vi.fn(),
  errorKey: () => 'errors.UNKNOWN',
}));
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

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  state.role = 'OPERATOR';
});

function panel(
  item: LeadPipelineItem | null,
  over: Partial<Parameters<typeof LeadPanel>[0]> = {},
) {
  const props = {
    item,
    stages: STAGES,
    opener: null,
    onClose: vi.fn(),
    onRequestMove: vi.fn(),
    ...over,
  };
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const ui = (next: LeadPipelineItem | null) => (
    <QueryClientProvider client={client}>
      <LeadPanel {...props} item={next} />
    </QueryClientProvider>
  );
  const view = render(ui(item));
  return {
    props,
    rerender: (next: LeadPipelineItem | null) => view.rerender(ui(next)),
  };
}

describe('LeadPanel', () => {
  it('is a modal dialog labelled by the customer name', () => {
    panel(makeLead());
    const dialog = screen.getByTestId('lead-panel');
    expect(dialog).toHaveAttribute('open');
    const title = screen.getByRole('heading', { name: 'Ada Lovelace' });
    expect(dialog.getAttribute('aria-labelledby')).toBe(title.id);
    expect(screen.getByText('Telegram')).toBeInTheDocument();
    expect(screen.getByText('+998901234567')).toBeInTheDocument();
  });

  it('is closed with no lead and Escape or the close button ask to close', () => {
    const { props } = panel(makeLead());
    fireEvent(
      screen.getByTestId('lead-panel'),
      new Event('cancel', { cancelable: true }),
    );
    expect(props.onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('lead-panel-close'));
    expect(props.onClose).toHaveBeenCalledTimes(2);
    cleanup();
    panel(null);
    expect(screen.getByTestId('lead-panel')).not.toHaveAttribute('open');
  });

  it('links to the conversation', () => {
    panel(makeLead());
    expect(screen.getByTestId('lead-panel-conversation')).toHaveAttribute(
      'href',
      '/inbox?scope=all&c=conv-1',
    );
  });

  it('shows every stage in order with the current one as the step', () => {
    panel(makeLead());
    const steps = within(screen.getByTestId('lead-panel-stages')).getAllByRole(
      'button',
    );
    expect(steps.map((s) => s.textContent)).toEqual([
      'New',
      'Qualified',
      'Won',
      'Lost',
    ]);
    expect(screen.getByTestId('lead-panel-stage-NEW')).toHaveAttribute(
      'aria-current',
      'step',
    );
    expect(
      screen.getByTestId('lead-panel-stage-QUALIFIED'),
    ).not.toHaveAttribute('aria-current');
  });

  it('a lead without a stage sits in the first one', () => {
    panel(makeLead({ pipelineStageId: null }));
    expect(screen.getByTestId('lead-panel-stage-NEW')).toHaveAttribute(
      'aria-current',
      'step',
    );
  });

  it('clicking another step asks to move the lead; the current step does nothing', () => {
    const lead = makeLead();
    const { props } = panel(lead);
    fireEvent.click(screen.getByTestId('lead-panel-stage-NEW'));
    expect(props.onRequestMove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('lead-panel-stage-LOST'));
    expect(props.onRequestMove).toHaveBeenCalledWith(lead, 'stage-lost');
  });

  it('shows the suggestion with reasons and posts accept and dismiss', async () => {
    vi.mocked(api).mockResolvedValue({});
    panel(
      makeLead({
        suggestedStageId: 'stage-qual',
        suggestedReasonCodes: ['offer_shown', 'made_up_code'],
      }),
    );
    expect(screen.getByTestId('lead-panel-suggestion').textContent).toBe(
      'leads.aiSuggestsChip|Qualified',
    );
    expect(
      screen.getByText('an offer was shown, automatic rule'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('lead-accept-suggestion'));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        '/api/v1/leads/lead-1/stage-suggestion/accept',
        { method: 'POST' },
      ),
    );
    fireEvent.click(screen.getByTestId('lead-dismiss-suggestion'));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        '/api/v1/leads/lead-1/stage-suggestion/dismiss',
        { method: 'POST' },
      ),
    );
  });

  it('offers "hand back to AI" only for operator-staged leads', async () => {
    vi.mocked(api).mockResolvedValue({});
    panel(makeLead({ stageSetBy: 'OPERATOR' }));
    fireEvent.click(screen.getByTestId('lead-hand-back-to-ai'));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith('/api/v1/leads/lead-1/hand-back-to-ai', {
        method: 'POST',
      }),
    );
    cleanup();
    panel(makeLead({ stageSetBy: 'AGENT' }));
    expect(screen.queryByTestId('lead-hand-back-to-ai')).toBeNull();
    expect(screen.getByText('leads.stageByAI')).toBeInTheDocument();
  });

  it('is read-only for a VIEWER: disabled steps, no AI block, no move to pipeline', () => {
    state.role = 'VIEWER';
    const { props } = panel(makeLead({ suggestedStageId: 'stage-qual' }));
    for (const step of within(
      screen.getByTestId('lead-panel-stages'),
    ).getAllByRole('button'))
      expect(step).toBeDisabled();
    fireEvent.click(screen.getByTestId('lead-panel-stage-WON'));
    expect(props.onRequestMove).not.toHaveBeenCalled();
    expect(screen.queryByTestId('lead-panel-ai')).toBeNull();
    expect(screen.queryByTestId('stub-move-to-pipeline')).toBeNull();
    expect(screen.getByTestId('stub-opportunity')).toBeInTheDocument();
  });

  it('contains opportunity, move to pipeline, tags and custom fields for an operator', () => {
    panel(makeLead());
    for (const id of [
      'stub-opportunity',
      'stub-move-to-pipeline',
      'stub-tags',
      'stub-fields',
    ])
      expect(screen.getByTestId(id)).toBeInTheDocument();
  });

  it('shows the lost reason', () => {
    panel(
      makeLead({ lostReason: 'too expensive', pipelineStageId: 'stage-lost' }),
    );
    expect(screen.getByTestId('lead-panel-lost-reason').textContent).toBe(
      'leads.lostBecause|too expensive',
    );
  });

  it('returns focus to the lead open button when it closes', () => {
    const lead = makeLead();
    const button = document.createElement('button');
    button.dataset.leadOpen = lead.id;
    document.body.appendChild(button);
    const { rerender } = panel(lead, { opener: null });
    rerender(null);
    expect(document.activeElement).toBe(button);
    button.remove();
  });
});
