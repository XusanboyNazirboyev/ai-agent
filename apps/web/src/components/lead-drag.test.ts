import { describe, expect, it } from 'vitest';
import {
  FLICK_VELOCITY,
  edgeScrollDelta,
  resolveDropTarget,
  swipeDecision,
} from './lead-drag';

const base = { width: 300, velocity: 0, index: 1, count: 4, canEdit: true };

describe('swipeDecision', () => {
  it('moves next past 40% to the right and previous to the left', () => {
    expect(swipeDecision({ ...base, dx: 121 })).toBe('next');
    expect(swipeDecision({ ...base, dx: -121 })).toBe('prev');
  });

  it('does nothing below the threshold', () => {
    expect(swipeDecision({ ...base, dx: 119 })).toBe('none');
    expect(swipeDecision({ ...base, dx: -119 })).toBe('none');
  });

  it('a fast flick moves even a short drag, a tiny twitch does not', () => {
    expect(
      swipeDecision({ ...base, dx: 40, velocity: FLICK_VELOCITY + 0.1 }),
    ).toBe('next');
    expect(
      swipeDecision({ ...base, dx: -40, velocity: -(FLICK_VELOCITY + 0.1) }),
    ).toBe('prev');
    expect(swipeDecision({ ...base, dx: 5, velocity: 2 })).toBe('none');
  });

  it('the edge stages have no further move', () => {
    expect(swipeDecision({ ...base, index: 3, dx: 200 })).toBe('none');
    expect(swipeDecision({ ...base, index: 0, dx: -200 })).toBe('none');
    expect(swipeDecision({ ...base, index: 0, dx: 200 })).toBe('next');
  });

  it('a viewer or a zero width never moves', () => {
    expect(swipeDecision({ ...base, dx: 250, canEdit: false })).toBe('none');
    expect(swipeDecision({ ...base, dx: 250, width: 0 })).toBe('none');
  });
});

describe('resolveDropTarget', () => {
  const rects = [
    { id: 'a', left: 0, right: 100, top: 0, bottom: 400 },
    { id: 'b', left: 110, right: 210, top: 0, bottom: 400 },
  ];
  it('finds the column under the pointer', () => {
    expect(resolveDropTarget({ x: 50, y: 10 }, rects)).toBe('a');
    expect(resolveDropTarget({ x: 150, y: 399 }, rects)).toBe('b');
  });
  it('is null in a gap or outside', () => {
    expect(resolveDropTarget({ x: 105, y: 10 }, rects)).toBeNull();
    expect(resolveDropTarget({ x: 50, y: 500 }, rects)).toBeNull();
  });
});

describe('edgeScrollDelta', () => {
  const bounds = { left: 0, right: 1000 };
  it('scrolls toward the edge the pointer nears', () => {
    expect(edgeScrollDelta(10, bounds)).toBeLessThan(0);
    expect(edgeScrollDelta(990, bounds)).toBeGreaterThan(0);
    expect(edgeScrollDelta(500, bounds)).toBe(0);
  });
});
