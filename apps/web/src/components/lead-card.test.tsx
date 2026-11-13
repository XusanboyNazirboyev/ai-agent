import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatAmount } from '@/lib/currencies';
import { STAGES, makeLead } from '@/test-fixtures/leads';
import type { LeadPipelineItem } from '@/lib/types';
import { LeadCard } from './lead-card';

const state = vi.hoisted(() => ({ role: 'OPERATOR' }));

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, values?: Record<string, string | number>) =>
      values ? `${key}|${Object.values(values).join(',')}` : key,
  }),
}));
vi.mock('./app-shell', () => ({
  useShell: () => ({
    operator: { id: 'op1', role: state.role },
    timeZone: 'UTC',
  }),
}));

const NOW = Date.parse('2026-11-13T12:00:00.000Z');
const daysAgo = (n: number): string =>
  new Date(NOW - n * 86_400_000 - 1000).toISOString();

function renderCard(
  item: LeadPipelineItem,
  stageId = 'stage-new',
  over: Partial<Parameters<typeof LeadCard>[0]> = {},
) {
  const props = {
    item,
    stage: STAGES.find((s) => s.id === stageId)!,
    stages: STAGES,
    draggedId: null,
    draggedToStageId: null,
    onDragStart: vi.fn(),
    onDragEnd: vi.fn(),
    onOpen: vi.fn(),
    onRequestMove: vi.fn(),
    onAnnounce: vi.fn(),
    ...over,
  };
  render(
    <ul>
      <LeadCard {...props} />
    </ul>,
  );
  return props;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  state.role = 'OPERATOR';
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('LeadCard', () => {
  it('has no inline controls other than the name button and the drag handle', () => {
    renderCard(
      makeLead({ stageSetBy: 'OPERATOR', suggestedStageId: 'stage-qual' }),
    );
    const card = screen.getByTestId('lead-card');
    expect(within(card).queryByRole('combobox')).toBeNull();
    expect(screen.queryByTestId('lead-accept-suggestion')).toBeNull();
    expect(screen.queryByTestId('lead-dismiss-suggestion')).toBeNull();
    expect(screen.queryByTestId('lead-hand-back-to-ai')).toBeNull();
    expect(card.tagName).toBe('ARTICLE');
    expect(card.getAttribute('role')).toBeNull();
    expect(card.getAttribute('tabindex')).toBeNull();
  });

  it('opens the panel from the name button and from the empty card area', () => {
    const props = renderCard(makeLead());
    const button = screen.getByRole('button', {
      name: 'leads.openLead|Ada Lovelace',
    });
    fireEvent.click(button);
    expect(props.onOpen).toHaveBeenCalledTimes(1);
    expect(props.onOpen).toHaveBeenLastCalledWith(props.item, button);
    fireEvent.click(screen.getByTestId('lead-card'));
    expect(props.onOpen).toHaveBeenCalledTimes(2);
    // The drag handle is not an open gesture.
    fireEvent.click(screen.getByTestId('lead-card-handle'));
    expect(props.onOpen).toHaveBeenCalledTimes(2);
  });

  it('shows the amount from the decimal string, nothing when null', () => {
    renderCard(makeLead({ amount: '1234567.89', currency: 'USD' }));
    expect(screen.getByTestId('lead-card-amount').textContent).toBe(
      formatAmount('1234567.89', 'USD'),
    );
    cleanup();
    renderCard(makeLead({ amount: null, currency: null }));
    expect(screen.queryByTestId('lead-card-amount')).toBeNull();
  });

  it('shows the channel and the owner as a labelled avatar', () => {
    renderCard(makeLead());
    expect(screen.getByTestId('lead-card-channel').textContent).toBe(
      'Telegram',
    );
    const owner = screen.getByTestId('lead-card-owner-name');
    expect(owner).toHaveAttribute('title', 'Grace Hopper');
    expect(owner).toHaveAttribute(
      'aria-label',
      'leads.ownerLabel|Grace Hopper',
    );
    expect(owner.textContent).toBe('GH');
  });

  it('shows two tags and "+N" for the rest', () => {
    const tags = ['a', 'b', 'c', 'd'].map((n) => ({
      id: `t-${n}`,
      name: n,
      color: null,
    }));
    renderCard(makeLead({ tags }));
    expect(screen.getAllByTestId('lead-card-tag')).toHaveLength(2);
    expect(screen.getByTestId('lead-card-tag-more').textContent).toBe('+2');
  });

  it('marks AI-staged leads only', () => {
    renderCard(makeLead({ stageSetBy: 'AGENT' }));
    expect(screen.getByTestId('lead-card-stage-by-ai')).toBeInTheDocument();
    cleanup();
    renderCard(makeLead({ stageSetBy: 'OPERATOR' }));
    expect(screen.queryByTestId('lead-card-stage-by-ai')).toBeNull();
  });

  it.each([
    [2, 'bg-surface-2'],
    [3, 'bg-warning-soft'],
    [6, 'bg-warning-soft'],
    [7, 'bg-danger-soft'],
    [20, 'bg-danger-soft'],
  ])('age chip at %s days uses %s and says it in text', (days, cls) => {
    renderCard(makeLead({ updatedAt: daysAgo(days) }));
    const chip = screen.getByTestId('lead-card-age');
    expect(chip.className).toContain(cls);
    expect(chip.textContent).toContain(`leads.ageDays|${days}`);
    expect(chip.textContent).toContain(`leads.ageLabel|${days}`);
  });

  it('hides the age chip in WON and LOST columns', () => {
    renderCard(makeLead({ updatedAt: daysAgo(30) }), 'stage-won');
    expect(screen.queryByTestId('lead-card-age')).toBeNull();
  });

  it('shows one "AI suggests" chip that opens the panel', () => {
    const props = renderCard(makeLead({ suggestedStageId: 'stage-qual' }));
    const chip = screen.getByTestId('lead-card-stage-suggested');
    expect(chip.textContent).toBe('leads.aiSuggestsChip|Qualified');
    fireEvent.click(chip);
    expect(props.onOpen).toHaveBeenCalledTimes(1);
  });

  it('shows no chip when the suggestion is the current stage', () => {
    renderCard(makeLead({ suggestedStageId: 'stage-new' }));
    expect(screen.queryByTestId('lead-card-stage-suggested')).toBeNull();
  });

  it('moves from the keyboard: Space, arrow, Space', () => {
    const props = renderCard(makeLead());
    const handle = screen.getByTestId('lead-card-handle');
    fireEvent.keyDown(handle, { key: ' ' });
    expect(handle).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('lead-card').dataset.state).toBe('picked-up');
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(screen.getByTestId('lead-card-live').textContent).toBe(
      'leads.dragTarget|Qualified',
    );
    fireEvent.keyDown(handle, { key: ' ' });
    expect(props.onRequestMove).toHaveBeenCalledWith(props.item, 'stage-qual');
    expect(props.onAnnounce).toHaveBeenCalledWith('leads.dragDropped');
  });

  it('Escape cancels a keyboard pick-up without moving', () => {
    const props = renderCard(makeLead());
    const handle = screen.getByTestId('lead-card-handle');
    fireEvent.keyDown(handle, { key: ' ' });
    fireEvent.keyDown(handle, { key: 'Escape' });
    expect(props.onRequestMove).not.toHaveBeenCalled();
    expect(handle).toHaveAttribute('aria-pressed', 'false');
  });

  it('a VIEWER gets no drag handle and a non-draggable card', () => {
    state.role = 'VIEWER';
    renderCard(makeLead());
    expect(screen.queryByTestId('lead-card-handle')).toBeNull();
    expect(screen.getByTestId('lead-card')).toHaveAttribute(
      'draggable',
      'false',
    );
  });

  it('pointer drag still reports the lead id', () => {
    const props = renderCard(makeLead());
    act(() => {
      fireEvent.dragStart(screen.getByTestId('lead-card'));
    });
    expect(props.onDragStart).toHaveBeenCalledWith('lead-1');
  });
});
