import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Button, buttonClass } from './button';

afterEach(cleanup);

// jsdom has no PointerEvent; without it the pointer fields (button, clientX)
// never reach the handler. A MouseEvent carries the same fields.
beforeAll(() => {
  if (!('PointerEvent' in window))
    Object.defineProperty(window, 'PointerEvent', { value: MouseEvent });
});

function box(button: HTMLElement): void {
  vi.spyOn(button, 'getBoundingClientRect').mockReturnValue({
    left: 100,
    top: 50,
    width: 120,
    height: 40,
    right: 220,
    bottom: 90,
    x: 100,
    y: 50,
    toJSON: () => ({}),
  } as DOMRect);
}

describe('Button press (owner 2026-11-16)', () => {
  it('pings a ring from the pressed point, sized to reach the far corner, then removes it', () => {
    const onPointerDown = vi.fn();
    render(<Button onPointerDown={onPointerDown}>Send</Button>);
    const button = screen.getByRole('button', { name: 'Send' });
    box(button);
    fireEvent.pointerDown(button, { button: 0, clientX: 110, clientY: 60 });
    expect(onPointerDown).toHaveBeenCalledOnce();
    const ring = button.querySelector<HTMLElement>('[data-ping]')!;
    expect(ring).not.toBeNull();
    expect(ring.style.left).toBe('10px');
    expect(ring.style.top).toBe('10px');
    // Farthest corner from (10, 10) in 120 x 40 is (120, 40): 2 * hypot(110, 30).
    expect(ring.style.getPropertyValue('--tz-ping-size')).toBe(
      `${Math.ceil(2 * Math.hypot(110, 30))}px`,
    );
    // The ring is decoration: the accessible name stays the label.
    expect(ring.parentElement?.getAttribute('aria-hidden')).toBe('true');
    fireEvent.animationEnd(ring);
    expect(button.querySelector('[data-ping]')).toBeNull();
  });

  it('pings from the centre for Enter and Space, not for other keys or repeats', () => {
    render(<Button>Save</Button>);
    const button = screen.getByRole('button', { name: 'Save' });
    box(button);
    fireEvent.keyDown(button, { key: 'a' });
    fireEvent.keyDown(button, { key: 'Enter', repeat: true });
    expect(button.querySelector('[data-ping]')).toBeNull();
    fireEvent.keyDown(button, { key: 'Enter' });
    const ring = button.querySelector<HTMLElement>('[data-ping]')!;
    expect(ring.style.left).toBe('60px');
    expect(ring.style.top).toBe('20px');
  });

  it('keeps at most three rings when clicked fast', () => {
    render(<Button>Go</Button>);
    const button = screen.getByRole('button', { name: 'Go' });
    box(button);
    for (let i = 0; i < 5; i++)
      fireEvent.pointerDown(button, { button: 0, clientX: 120, clientY: 70 });
    expect(button.querySelectorAll('[data-ping]')).toHaveLength(3);
  });

  it('does nothing on a disabled or loading button, or a right click', () => {
    render(
      <>
        <Button disabled>Off</Button>
        <Button loading>Busy</Button>
        <Button>Menu</Button>
      </>,
    );
    for (const name of ['Off', 'Busy']) {
      const button = screen.getByRole('button', { name });
      box(button);
      fireEvent.pointerDown(button, { button: 0, clientX: 110, clientY: 60 });
      expect(button.querySelector('[data-ping]')).toBeNull();
    }
    const menu = screen.getByRole('button', { name: 'Menu' });
    box(menu);
    fireEvent.pointerDown(menu, { button: 2, clientX: 110, clientY: 60 });
    expect(menu.querySelector('[data-ping]')).toBeNull();
  });

  it('gives links styled as buttons the same press', () => {
    expect(buttonClass('primary')).toContain('tz-press');
  });
});
