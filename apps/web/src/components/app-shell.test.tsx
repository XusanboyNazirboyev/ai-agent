import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { AccessBanner } from './app-shell';

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      key === 'banner.pastDue' ? `past:${String(values?.date ?? '')}` : key,
    locale: 'en',
  }),
}));

afterEach(() => cleanup());

describe('AccessBanner', () => {
  it('renders nothing when healthy or missing access', () => {
    const { container, rerender } = render(
      <AccessBanner access={undefined} manager={false} />,
    );
    expect(container).toBeEmptyDOMElement();
    rerender(
      <AccessBanner
        access={{ state: 'ok', periodEnd: null, graceUntil: null }}
        manager={false}
      />,
    );
    expect(screen.queryByTestId('access-banner')).not.toBeInTheDocument();
  });

  it('renders expired banner and subscription link for manager', () => {
    render(
      <AccessBanner
        access={{
          state: 'SUBSCRIPTION_EXPIRED',
          periodEnd: null,
          graceUntil: null,
        }}
        manager
      />,
    );
    const banner = screen.getByTestId('access-banner');
    expect(banner).toHaveAttribute('data-state', 'expired');
    expect(banner).toHaveTextContent('banner.expired');
    expect(
      screen.getByRole('link', { name: 'banner.subscriptionLink' }),
    ).toHaveAttribute('href', '/settings/subscription');
  });

  it('renders past-due warning when ok with graceUntil', () => {
    render(
      <AccessBanner
        access={{
          state: 'ok',
          periodEnd: null,
          graceUntil: '2026-12-01T00:00:00.000Z',
        }}
        manager={false}
      />,
    );
    const banner = screen.getByTestId('access-banner');
    expect(banner).toHaveAttribute('data-state', 'past-due');
    expect(banner.textContent).toContain('past:');
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});
