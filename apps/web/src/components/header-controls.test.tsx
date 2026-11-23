import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThemeToggle, UserMenu } from './header-controls';

const setTheme = vi.fn();
let theme: 'system' | 'light' | 'dark' = 'light';
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/preferences', () => ({
  usePreferences: () => ({ theme, setTheme }),
}));

afterEach(() => {
  cleanup();
  setTheme.mockReset();
});

describe('header controls (owner 2026-11-23)', () => {
  it('switches light to dark and dark to light in one tap', () => {
    theme = 'light';
    render(<ThemeToggle />);
    fireEvent.click(screen.getByTestId('theme-toggle'));
    expect(setTheme).toHaveBeenCalledWith('dark');
    cleanup();
    theme = 'dark';
    render(<ThemeToggle />);
    expect(screen.getByTestId('theme-toggle')).toHaveAttribute(
      'aria-label',
      'header.themeLight',
    );
    fireEvent.click(screen.getByTestId('theme-toggle'));
    expect(setTheme).toHaveBeenCalledWith('light');
  });

  it('keeps sign-out in the account menu, which Escape closes', () => {
    const onLogout = vi.fn();
    render(<UserMenu name="Xusanboy" role="OWNER" onLogout={onLogout} />);
    expect(screen.queryByTestId('logout')).toBeNull();
    fireEvent.click(screen.getByTestId('user-menu'));
    expect(screen.getByTestId('user-menu')).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('logout')).toBeNull();
    fireEvent.click(screen.getByTestId('user-menu'));
    fireEvent.click(screen.getByTestId('logout'));
    expect(onLogout).toHaveBeenCalledOnce();
  });
});
