'use client';

import { useEffect } from 'react';

/**
 * Remembers whether the person last used a pointer (mouse, touch, pen) or
 * the keyboard, as `data-input` on <html>. Browsers draw a focus ring on
 * focus they move themselves (a dialog giving focus back, a scroll region
 * focused by a click), which looked like stray blue lines after a mouse
 * click (owner reports 2026-11-16). globals.css hides rings while the last
 * input was a pointer, except on text fields; any key brings them back at
 * once, so keyboard users always see where they are.
 */
export function useInputModality(): void {
  useEffect(() => {
    const root = document.documentElement;
    const pointer = (): void => {
      root.dataset.input = 'pointer';
    };
    const keyboard = (event: KeyboardEvent): void => {
      // A modifier on its own (e.g. Cmd before a shortcut) is not navigation.
      if (['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) return;
      root.dataset.input = 'keyboard';
    };
    document.addEventListener('pointerdown', pointer, true);
    document.addEventListener('keydown', keyboard, true);
    return () => {
      document.removeEventListener('pointerdown', pointer, true);
      document.removeEventListener('keydown', keyboard, true);
      delete root.dataset.input;
    };
  }, []);
}
