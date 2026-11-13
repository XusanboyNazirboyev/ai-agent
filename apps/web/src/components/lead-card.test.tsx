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
    onDragOver: vi.fn(),
    onDrop: vi.fn(),
    swipe: false,
    onSwipe: vi.fn(),
    ...over,
  };
  render(
    <ul>
      <LeadCard {...props} />
    </ul>,
  );
  return props;
}

/** jsdom has no PointerEvent: a mouse event carrying the pointer fields. */
function pointer(
  el: Element,
  type: 'pointerDown' | 'pointerMove' | 'pointerUp',
  init: {
    pointerId: number;
    pointerType: string;
    clientX: number;
    clientY: number;
    button?: number;
  },
): void {
  const event = new MouseEvent(type.toLowerCase(), {
    bubbles: true,
    cancelable: true,
    clientX: init.clientX,
    clientY: init.clientY,
    button: init.button ?? 0,
  });
  Object.defineProperty(event, 'pointerId', { value: init.pointerId });
  Object.defineProperty(event, 'pointerType', { value: init.pointerType });
  act(() => {
    el.dispatchEvent(event);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
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

  it('shows one generic "AI suggestion" chip, without a stage name, that opens the panel', () => {
    const props = renderCard(makeLead({ suggestedStageId: 'stage-qual' }));
    const chip = screen.getByTestId('lead-card-stage-suggested');
    expect(chip.textContent).toBe('leads.aiSuggestionChip');
    fireEvent.click(chip);
    expect(props.onOpen).toHaveBeenCalledTimes(1);
  });

  it('never shows a stage name or stage control on the card', () => {
    renderCard(
      makeLead({ suggestedStageId: 'stage-qual', stageSetBy: 'AGENT' }),
    );
    const visible = screen.getByTestId('lead-card').textContent ?? '';
    for (const stage of STAGES) expect(visible).not.toContain(stage.name!);
    expect(
      within(screen.getByTestId('lead-card')).queryByRole('combobox'),
    ).toBeNull();
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

  it('a VIEWER gets no drag handle and cannot drag with a pointer', () => {
    state.role = 'VIEWER';
    const props = renderCard(makeLead());
    expect(screen.queryByTestId('lead-card-handle')).toBeNull();
    const card = screen.getByTestId('lead-card');
    card.setPointerCapture = vi.fn();
    pointer(card, 'pointerDown', {
      pointerId: 9,
      pointerType: 'mouse',
      clientX: 0,
      clientY: 0,
    });
    pointer(card, 'pointerMove', {
      pointerId: 9,
      pointerType: 'mouse',
      clientX: 200,
      clientY: 0,
    });
    pointer(card, 'pointerUp', {
      pointerId: 9,
      pointerType: 'mouse',
      clientX: 200,
      clientY: 0,
    });
    expect(props.onDragStart).not.toHaveBeenCalled();
    expect(props.onDrop).not.toHaveBeenCalled();
  });

  it('a mouse drag past the slop reports start, hover and drop on the column under it', () => {
    const props = renderCard(makeLead());
    const card = screen.getByTestId('lead-card');
    const column = document.createElement('section');
    column.dataset.stageDrop = 'stage-qual';
    document.body.appendChild(column);
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      value: () => [column],
    });
    card.setPointerCapture = vi.fn();
    pointer(card, 'pointerDown', {
      pointerId: 1,
      pointerType: 'mouse',
      button: 0,
      clientX: 10,
      clientY: 10,
    });
    pointer(card, 'pointerMove', {
      pointerId: 1,
      pointerType: 'mouse',
      clientX: 12,
      clientY: 10,
    });
    expect(props.onDragStart).not.toHaveBeenCalled();
    pointer(card, 'pointerMove', {
      pointerId: 1,
      pointerType: 'mouse',
      clientX: 200,
      clientY: 30,
    });
    expect(props.onDragStart).toHaveBeenCalledWith('lead-1');
    expect(props.onDragOver).toHaveBeenLastCalledWith('stage-qual');
    expect(card.style.transform).toBe('translate(190px, 20px)');
    pointer(card, 'pointerUp', {
      pointerId: 1,
      pointerType: 'mouse',
      clientX: 200,
      clientY: 30,
    });
    expect(props.onDrop).toHaveBeenCalledWith('stage-qual');
    expect(props.onDragEnd).toHaveBeenCalled();
    // The click that ends a drag does not open the panel.
    fireEvent.click(card);
    expect(props.onOpen).not.toHaveBeenCalled();
    column.remove();
    Reflect.deleteProperty(document, 'elementsFromPoint');
  });

  it('a plain click still opens the panel (no drag below the slop)', () => {
    const props = renderCard(makeLead());
    const card = screen.getByTestId('lead-card');
    pointer(card, 'pointerDown', {
      pointerId: 1,
      pointerType: 'mouse',
      button: 0,
      clientX: 10,
      clientY: 10,
    });
    pointer(card, 'pointerUp', {
      pointerId: 1,
      pointerType: 'mouse',
      clientX: 10,
      clientY: 10,
    });
    fireEvent.click(card);
    expect(props.onOpen).toHaveBeenCalledTimes(1);
    expect(props.onDragStart).not.toHaveBeenCalled();
  });

  it('swipe mode: a long drag to the right asks to move next, a short one snaps back', () => {
    const props = renderCard(makeLead(), 'stage-qual', { swipe: true });
    const card = screen.getByTestId('lead-card');
    card.setPointerCapture = vi.fn();
    card.getBoundingClientRect = () => ({ width: 300 }) as DOMRect;
    pointer(card, 'pointerDown', {
      pointerId: 2,
      pointerType: 'mouse',
      button: 0,
      clientX: 0,
      clientY: 0,
    });
    pointer(card, 'pointerMove', {
      pointerId: 2,
      pointerType: 'mouse',
      clientX: 50,
      clientY: 40,
    });
    expect(card.style.transform).toBe('translate(50px, 0px)');
    pointer(card, 'pointerUp', {
      pointerId: 2,
      pointerType: 'mouse',
      clientX: 50,
      clientY: 40,
    });
    expect(props.onSwipe).not.toHaveBeenCalled();
    expect(card.style.transform).toBe('');
    pointer(card, 'pointerDown', {
      pointerId: 3,
      pointerType: 'mouse',
      button: 0,
      clientX: 0,
      clientY: 0,
    });
    pointer(card, 'pointerMove', {
      pointerId: 3,
      pointerType: 'mouse',
      clientX: 200,
      clientY: 0,
    });
    pointer(card, 'pointerUp', {
      pointerId: 3,
      pointerType: 'mouse',
      clientX: 200,
      clientY: 0,
    });
    expect(props.onSwipe).toHaveBeenCalledWith(props.item, 'next');
  });

  it('a touch that moves before the long press is a scroll, not a drag', () => {
    vi.useFakeTimers();
    const props = renderCard(makeLead());
    const card = screen.getByTestId('lead-card');
    pointer(card, 'pointerDown', {
      pointerId: 4,
      pointerType: 'touch',
      clientX: 0,
      clientY: 0,
    });
    pointer(card, 'pointerMove', {
      pointerId: 4,
      pointerType: 'touch',
      clientX: 0,
      clientY: 60,
    });
    vi.advanceTimersByTime(400);
    expect(props.onDragStart).not.toHaveBeenCalled();
  });

  it('a touch held in place starts the drag after the long press', () => {
    vi.useFakeTimers();
    const props = renderCard(makeLead());
    const card = screen.getByTestId('lead-card');
    card.setPointerCapture = vi.fn();
    pointer(card, 'pointerDown', {
      pointerId: 5,
      pointerType: 'touch',
      clientX: 0,
      clientY: 0,
    });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(props.onDragStart).toHaveBeenCalledWith('lead-1');
  });

  it('the handle is the only element with touch-action none', () => {
    renderCard(makeLead());
    expect(screen.getByTestId('lead-card-handle').className).toContain(
      'touch-none',
    );
    expect(screen.getByTestId('lead-card').className).not.toContain(
      'touch-none',
    );
  });
});
