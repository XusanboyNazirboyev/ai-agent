import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  LONG_PRESS_MS,
  MOVE_SLOP,
  edgeScrollDelta,
  resolveDropTarget,
  swipeDecision,
  type DropRect,
  type SwipeDirection,
} from './lead-drag';

interface Gesture {
  pointerId: number;
  pointerType: string;
  fromHandle: boolean;
  startX: number;
  startY: number;
  lastX: number;
  lastT: number;
  velocity: number;
  x: number;
  y: number;
  dragging: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  scrollTimer: ReturnType<typeof setInterval> | null;
}

const SCROLLER = '[data-testid="leads-board-scroller"]';

/** Column rects from the DOM (elementsFromPoint is checked first for speed). */
function dropTargetAt(x: number, y: number): string | null {
  if (typeof document.elementsFromPoint === 'function') {
    for (const el of document.elementsFromPoint(x, y)) {
      const id = (el as HTMLElement).dataset?.stageDrop;
      if (id) return id;
    }
    return null;
  }
  const rects: DropRect[] = Array.from(
    document.querySelectorAll<HTMLElement>('[data-stage-drop]'),
  ).map((el) => {
    const r = el.getBoundingClientRect();
    return {
      id: el.dataset.stageDrop ?? '',
      left: r.left,
      right: r.right,
      top: r.top,
      bottom: r.bottom,
    };
  });
  return resolveDropTarget({ x, y }, rects);
}

/**
 * One pointer-events implementation for mouse, pen and touch. Mouse and pen
 * drag the card body or the handle past a small slop; touch needs a long
 * press on the card (so the page still scrolls) or a drag from the handle
 * (the only element with touch-action none). In swipe mode (one column at a
 * time) the card follows the finger sideways and a threshold decides.
 */
export function useCardDrag(props: {
  enabled: boolean;
  swipe: boolean;
  index: number;
  count: number;
  onStart: () => void;
  onOver: (stageId: string | null) => void;
  onDropOn: (stageId: string) => void;
  onSwipe: (direction: Exclude<SwipeDirection, 'none'>) => void;
  onEnd: () => void;
}): {
  dragging: boolean;
  style: CSSProperties;
  handlers: {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void;
    onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void;
    onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => void;
  };
  /** True right after a drag, so the click it ends does not open the panel. */
  consumeClick: () => boolean;
} {
  const gesture = useRef<Gesture | null>(null);
  const suppress = useRef(false);
  const latest = useRef(props);
  latest.current = props;
  const [offset, setOffset] = useState<{ x: number; y: number } | null>(null);

  const clear = useCallback((): void => {
    const g = gesture.current;
    if (g?.timer) clearTimeout(g.timer);
    if (g?.scrollTimer) clearInterval(g.scrollTimer);
    gesture.current = null;
    setOffset(null);
  }, []);
  useEffect(() => clear, [clear]);

  // While a touch drag is live the page must not scroll under the finger.
  const dragging = offset !== null;
  useEffect(() => {
    if (!dragging) return;
    const block = (e: TouchEvent): void => {
      if (e.cancelable) e.preventDefault();
    };
    document.addEventListener('touchmove', block, { passive: false });
    return (): void => document.removeEventListener('touchmove', block);
  }, [dragging]);

  function begin(el: HTMLElement): void {
    const g = gesture.current;
    if (!g || g.dragging) return;
    g.dragging = true;
    try {
      el.setPointerCapture(g.pointerId);
    } catch {
      // The pointer is already gone: the next event ends the gesture.
    }
    setOffset({ x: 0, y: 0 });
    latest.current.onStart();
    if (!latest.current.swipe) {
      g.scrollTimer = setInterval(() => {
        const scroller = document.querySelector<HTMLElement>(SCROLLER);
        const cur = gesture.current;
        if (!scroller || !cur) return;
        const r = scroller.getBoundingClientRect();
        const step = edgeScrollDelta(cur.x, r);
        if (step !== 0) {
          scroller.scrollLeft += step;
          latest.current.onOver(dropTargetAt(cur.x, cur.y));
        }
      }, 16);
    }
  }

  const handlers = {
    onPointerDown(e: ReactPointerEvent<HTMLElement>): void {
      const p = latest.current;
      if (!p.enabled || gesture.current) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const target = e.target as HTMLElement;
      const handle = target.closest('[data-testid="lead-card-handle"]');
      // Other controls (name, chips) keep their own click behaviour.
      if (!handle && target.closest('button, a')) return;
      const el = e.currentTarget;
      const g: Gesture = {
        pointerId: e.pointerId,
        pointerType: e.pointerType,
        fromHandle: !!handle,
        startX: e.clientX,
        startY: e.clientY,
        lastX: e.clientX,
        lastT: e.timeStamp,
        velocity: 0,
        x: e.clientX,
        y: e.clientY,
        dragging: false,
        timer: null,
        scrollTimer: null,
      };
      gesture.current = g;
      if (e.pointerType === 'touch' && !handle) {
        g.timer = setTimeout(() => begin(el), LONG_PRESS_MS);
      }
    },
    onPointerMove(e: ReactPointerEvent<HTMLElement>): void {
      const g = gesture.current;
      if (!g || e.pointerId !== g.pointerId) return;
      const dx = e.clientX - g.startX;
      const dy = e.clientY - g.startY;
      if (!g.dragging) {
        const moved = Math.hypot(dx, dy) > MOVE_SLOP;
        if (!moved) return;
        if (g.timer) {
          clearTimeout(g.timer);
          g.timer = null;
        }
        // A touch that moves before the long press is a scroll, not a drag.
        if (g.pointerType === 'touch' && !g.fromHandle) {
          gesture.current = null;
          return;
        }
        begin(e.currentTarget);
      }
      const dt = e.timeStamp - g.lastT;
      if (dt > 0) g.velocity = (e.clientX - g.lastX) / dt;
      g.lastX = e.clientX;
      g.lastT = e.timeStamp;
      g.x = e.clientX;
      g.y = e.clientY;
      if (latest.current.swipe) {
        setOffset({ x: dx, y: 0 });
      } else {
        setOffset({ x: dx, y: dy });
        latest.current.onOver(dropTargetAt(e.clientX, e.clientY));
      }
    },
    onPointerUp(e: ReactPointerEvent<HTMLElement>): void {
      const g = gesture.current;
      if (!g || e.pointerId !== g.pointerId) return;
      const p = latest.current;
      if (g.dragging) {
        suppress.current = true;
        setTimeout(() => {
          suppress.current = false;
        }, 0);
        // End first: the drop or swipe then sets the final announcement.
        p.onEnd();
        if (p.swipe) {
          const dx = e.clientX - g.startX;
          const direction = swipeDecision({
            dx,
            width: e.currentTarget.getBoundingClientRect().width,
            velocity: g.velocity,
            index: p.index,
            count: p.count,
            canEdit: p.enabled,
          });
          if (direction !== 'none') p.onSwipe(direction);
        } else {
          const target = dropTargetAt(e.clientX, e.clientY);
          if (target) p.onDropOn(target);
        }
      }
      clear();
    },
    onPointerCancel(e: ReactPointerEvent<HTMLElement>): void {
      const g = gesture.current;
      if (!g || e.pointerId !== g.pointerId) return;
      if (g.dragging) latest.current.onEnd();
      clear();
    },
  };

  const style: CSSProperties = offset
    ? {
        transform: `translate(${offset.x}px, ${offset.y}px)`,
        zIndex: 50,
        position: 'relative',
        userSelect: 'none',
      }
    : {};
  return {
    dragging,
    style,
    handlers,
    consumeClick: () => suppress.current,
  };
}
