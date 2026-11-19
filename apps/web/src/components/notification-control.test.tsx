import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NotificationControl } from './notification-control';

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (k: string) => k }) }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('NotificationControl', () => {
  it('says not supported when the browser has no Notification', () => {
    vi.stubGlobal('Notification', undefined);
    render(<NotificationControl />);
    expect(screen.getByText('permission.unsupported')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows blocked without a button', () => {
    vi.stubGlobal('Notification', { permission: 'denied' });
    render(<NotificationControl />);
    expect(screen.getByText('permission.denied')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('asks for permission only on a click, then shows on', async () => {
    const fake = {
      permission: 'default',
      requestPermission: vi.fn(() => {
        fake.permission = 'granted';
        return Promise.resolve('granted');
      }),
    };
    vi.stubGlobal('Notification', fake);
    render(<NotificationControl />);
    expect(fake.requestPermission).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole('button', { name: 'header.notifications' }),
    );
    await waitFor(() =>
      expect(screen.getByText('permission.granted')).toBeTruthy(),
    );
    expect(fake.requestPermission).toHaveBeenCalledTimes(1);
  });
});
