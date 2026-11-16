import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Select } from './select';

afterEach(cleanup);

beforeAll(() => {
  if (!('PointerEvent' in window))
    Object.defineProperty(window, 'PointerEvent', { value: MouseEvent });
});

function row(select: HTMLElement): HTMLElement {
  return select.parentElement!;
}

describe('Select focus ring (owner screenshot 2026-11-16)', () => {
  it('shows the ring for keyboard focus only; a mouse press hides it until a key or blur', () => {
    render(
      <Select aria-label="Language" defaultValue="uz">
        <option value="uz">O‘zbekcha</option>
        <option value="en">English</option>
      </Select>,
    );
    const select = screen.getByRole('combobox', { name: 'Language' });
    // The select itself never draws a second ring inside the row.
    expect(select.className).toContain('tz-select');
    expect(row(select).className).toContain('has-[:focus-visible]:outline-2');

    fireEvent.pointerDown(select);
    expect(row(select).dataset.pointer).toBe('true');
    expect(row(select).className).not.toContain('has-[:focus-visible]:outline');

    // Tab only leaves: the ring stays hidden until focus is gone.
    fireEvent.keyDown(select, { key: 'Tab' });
    fireEvent.keyDown(select, { key: 'Escape' });
    expect(row(select).className).not.toContain('has-[:focus-visible]:outline');
    fireEvent.keyDown(select, { key: 'ArrowDown' });
    expect(row(select).className).toContain('has-[:focus-visible]:outline-2');

    fireEvent.pointerDown(select);
    fireEvent.blur(select);
    expect(row(select).dataset.pointer).toBeUndefined();
    expect(row(select).className).toContain('has-[:focus-visible]:outline-2');
  });

  it('opens the picker from a click on the chevron or the icon, not twice from the select itself', () => {
    render(
      <Select aria-label="Language" icon="globe">
        <option value="uz">O‘zbekcha</option>
      </Select>,
    );
    const select = screen.getByRole('combobox', { name: 'Language' });
    const showPicker = vi.fn();
    Object.defineProperty(select, 'showPicker', { value: showPicker });
    const [icon, chevron] = Array.from(row(select).querySelectorAll('svg'));
    fireEvent.click(chevron!);
    expect(showPicker).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(select);
    expect(row(select).dataset.pointer).toBe('true');
    fireEvent.click(icon!);
    expect(showPicker).toHaveBeenCalledTimes(2);
    // A click on the select opens it natively; the row adds nothing.
    fireEvent.click(select);
    expect(showPicker).toHaveBeenCalledTimes(2);
  });

  it('only focuses where showPicker is missing or refused, and ignores a disabled select', () => {
    render(
      <>
        <Select aria-label="A">
          <option value="a">A</option>
        </Select>
        <Select aria-label="B" disabled>
          <option value="b">B</option>
        </Select>
      </>,
    );
    const a = screen.getByRole('combobox', { name: 'A' });
    Object.defineProperty(a, 'showPicker', {
      value: () => {
        throw new Error('NotAllowedError');
      },
    });
    fireEvent.click(row(a).querySelector('svg')!);
    expect(document.activeElement).toBe(a);
    const b = screen.getByRole('combobox', { name: 'B' });
    const picker = vi.fn();
    Object.defineProperty(b, 'showPicker', { value: picker });
    fireEvent.click(row(b).querySelector('svg')!);
    expect(picker).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(b);
  });

  it('still calls the handlers it was given', () => {
    const calls: string[] = [];
    render(
      <Select
        aria-label="Pick"
        onPointerDown={() => calls.push('pointer')}
        onKeyDown={() => calls.push('key')}
        onBlur={() => calls.push('blur')}
      >
        <option value="a">A</option>
      </Select>,
    );
    const select = screen.getByRole('combobox', { name: 'Pick' });
    fireEvent.pointerDown(select);
    fireEvent.keyDown(select, { key: 'a' });
    fireEvent.blur(select);
    expect(calls).toEqual(['pointer', 'key', 'blur']);
  });
});
