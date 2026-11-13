/** Pure parts of dragging a lead card: swipe decision, drop target, edge scroll. */

/** A swipe moves the card when dragged past this share of its width. */
export const SWIPE_FRACTION = 0.4;
/** Or when released faster than this (px per ms) after a short drag. */
export const FLICK_VELOCITY = 0.5;
export const FLICK_MIN_PX = 24;
/** Touch drags start after a long press, so vertical scrolling keeps working. */
export const LONG_PRESS_MS = 250;
/** Movement (px) that cancels a pending long press / starts a mouse drag. */
export const MOVE_SLOP = 8;
export const EDGE_SCROLL_ZONE = 48;
export const EDGE_SCROLL_STEP = 14;

export type SwipeDirection = 'next' | 'prev' | 'none';

/**
 * Which way a finished horizontal drag moves the card: right goes to the next
 * stage, left to the previous one; the first and last stage have no further
 * move; a viewer cannot move anything.
 */
export function swipeDecision(input: {
  dx: number;
  width: number;
  /** Signed horizontal speed at release, px per ms. */
  velocity: number;
  index: number;
  count: number;
  canEdit: boolean;
}): SwipeDirection {
  if (!input.canEdit || input.width <= 0) return 'none';
  const far = Math.abs(input.dx) >= input.width * SWIPE_FRACTION;
  const flick =
    Math.abs(input.velocity) >= FLICK_VELOCITY &&
    Math.abs(input.dx) >= FLICK_MIN_PX;
  if (!far && !flick) return 'none';
  const direction = input.dx > 0 ? 1 : -1;
  const target = input.index + direction;
  if (target < 0 || target >= input.count) return 'none';
  return direction > 0 ? 'next' : 'prev';
}

export interface DropRect {
  id: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** The column under the pointer, or null (pure: rects come from the DOM). */
export function resolveDropTarget(
  point: { x: number; y: number },
  rects: DropRect[],
): string | null {
  const hit = rects.find(
    (r) =>
      point.x >= r.left &&
      point.x <= r.right &&
      point.y >= r.top &&
      point.y <= r.bottom,
  );
  return hit?.id ?? null;
}

/** Horizontal auto-scroll step for a pointer near the scroller's edges. */
export function edgeScrollDelta(
  x: number,
  bounds: { left: number; right: number },
  zone: number = EDGE_SCROLL_ZONE,
  step: number = EDGE_SCROLL_STEP,
): number {
  if (x < bounds.left + zone) return -step;
  if (x > bounds.right - zone) return step;
  return 0;
}
