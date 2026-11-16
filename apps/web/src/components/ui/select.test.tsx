import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
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

  it('lets a click on the icon or the chevron fall through to the select itself (owner report 2026-11-16)', () => {
    render(
      <Select aria-label="Language" icon="globe">
        <option value="uz">O‘zbekcha</option>
      </Select>,
    );
    const select = screen.getByRole('combobox', { name: 'Language' });
    const [icon, chevron] = Array.from(row(select).querySelectorAll('svg'));
    // Drawn over the select, never catching the pointer.
    expect(icon!.getAttribute('class')).toContain('pointer-events-none');
    expect(chevron!.getAttribute('class')).toContain('pointer-events-none');
    // The select reaches under both, so the native picker opens anywhere.
    expect(select.className).toContain('-ml-9');
    expect(select.className).toContain('-mr-9');
    expect(select.className).toContain('self-stretch');
  });

  it('reaches only under the row padding when there is no icon', () => {
    render(
      <Select aria-label="Plain">
        <option value="a">A</option>
      </Select>,
    );
    const select = screen.getByRole('combobox', { name: 'Plain' });
    expect(select.className).toContain('-ml-3');
    expect(select.className).not.toContain('-ml-9');
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

describe('every select is this component (owner report 2026-11-16)', () => {
  it('leaves no bare <select> elsewhere: those had no chevron at all', () => {
    const root = join(process.cwd(), 'src');
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) return files(path);
        return /\.tsx$/u.test(name) && !/\.test\.tsx$/u.test(name)
          ? [path]
          : [];
      });
    const bare = files(root)
      .filter((path) => !path.endsWith(join('components', 'ui', 'select.tsx')))
      .filter((path) => /<select\b/u.test(readFileSync(path, 'utf8')))
      .map((path) => relative(root, path));
    expect(bare).toEqual([]);
  });
});
