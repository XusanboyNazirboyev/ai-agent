import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NotificationBell, ThemeToggle, UserMenu } from './header-controls';
import type { FeedItem } from '@/lib/notification-feed';

const setTheme = vi.fn();
let theme: 'system' | 'light' | 'dark' = 'light';
vi.mock('@/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key, formatDateTime: () => 'time' }),
}));
vi.mock('./notification-control', () => ({ NotificationControl: () => null }));
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

  it('the bell counts unread items and opens one where it leads', () => {
    const items: FeedItem[] = [
      {
        id: 'a',
        type: 'handover.created',
        at: '2026-11-24T08:00:00Z',
        conversationId: 'c1',
        title: null,
        read: false,
      },
      {
        id: 'b',
        type: 'task.due',
        at: '2026-11-24T07:00:00Z',
        conversationId: null,
        title: 'Call Ali',
        read: true,
      },
    ];
    const onOpen = vi.fn();
    const onMarkAllRead = vi.fn();
    render(
      <NotificationBell
        items={items}
        onOpen={onOpen}
        onMarkAllRead={onMarkAllRead}
      />,
    );
    expect(screen.getByTestId('notification-count')).toHaveTextContent('1');
    fireEvent.click(screen.getByTestId('notification-bell'));
    expect(screen.getAllByTestId('notification-item')).toHaveLength(2);
    expect(screen.getByText('Call Ali')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('notification-read-all'));
    expect(onMarkAllRead).toHaveBeenCalledOnce();
    fireEvent.click(screen.getAllByTestId('notification-item')[0]!);
    expect(onOpen).toHaveBeenCalledWith(items[0], '/inbox?c=c1');
    expect(screen.queryByTestId('notification-panel')).toBeNull();
  });
});
