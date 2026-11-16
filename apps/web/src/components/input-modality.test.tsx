import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useInputModality } from './input-modality';

function Probe(): null {
  useInputModality();
  return null;
}

afterEach(cleanup);

describe('input modality (owner reports 2026-11-16)', () => {
  it('marks pointer use and keyboard use on <html>, ignoring a bare modifier', () => {
    render(<Probe />);
    const root = document.documentElement;
    fireEvent.pointerDown(document.body);
    expect(root.dataset.input).toBe('pointer');
    fireEvent.keyDown(document.body, { key: 'Meta' });
    expect(root.dataset.input).toBe('pointer');
    fireEvent.keyDown(document.body, { key: 'Tab' });
    expect(root.dataset.input).toBe('keyboard');
    fireEvent.pointerDown(document.body);
    expect(root.dataset.input).toBe('pointer');
  });

  it('cleans up when unmounted', () => {
    const { unmount } = render(<Probe />);
    fireEvent.keyDown(document.body, { key: 'Tab' });
    unmount();
    expect(document.documentElement.dataset.input).toBeUndefined();
  });
});
