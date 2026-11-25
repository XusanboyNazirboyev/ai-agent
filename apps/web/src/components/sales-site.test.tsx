import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/i18n';
import { SalesSite } from './sales-site';

const replace = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace }),
}));

function answer(plans: unknown, meOk = false): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      const ok = url.includes('/public/plans') || meOk;
      const body = url.includes('/public/plans') ? plans : { operator: {} };
      return Promise.resolve({
        ok,
        status: ok ? 200 : 401,
        text: () => Promise.resolve(JSON.stringify(ok ? body : {})),
      });
    }),
  );
}

function view(): void {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider>
        <SalesSite />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  replace.mockClear();
});

describe('SalesSite', () => {
  it('shows plans from the API with signup links, limits and no contact button without a link', async () => {
    answer({
      contactUrl: null,
      plans: [
        {
          code: 'basic',
          name: 'Basic',
          priceMinor: '19900000',
          currency: 'UZS',
          periodDays: 30,
          limits: { monthlyNewLeads: 500 },
        },
      ],
    });
    view();
    expect(await screen.findByTestId('site-plan')).toHaveTextContent('Basic');
    expect(screen.getByTestId('site-plan')).toHaveTextContent('500 new leads');
    expect(screen.getByRole('link', { name: /Choose Basic/ })).toHaveAttribute(
      'href',
      '/signup?plan=basic',
    );
    expect(screen.getByTestId('site-enterprise')).toHaveTextContent(
      'Price by agreement',
    );
    expect(screen.queryByTestId('site-contact')).toBeNull();
    expect(screen.getByRole('heading', { level: 1 })).toBeTruthy();
  });

  it('shows only the enterprise card and the CTA when there are no plans, with the contact button when given', async () => {
    answer({ plans: [], contactUrl: 'https://t.me/tezda' });
    view();
    expect(await screen.findByTestId('site-contact')).toHaveAttribute(
      'href',
      'https://t.me/tezda',
    );
    expect(screen.queryAllByTestId('site-plan')).toHaveLength(0);
    // Owner 2026-11-24: no chat for the form yet, so Telegram only.
    expect(screen.queryByTestId('site-contact-form')).toBeNull();
    expect(
      screen.getAllByRole('link', { name: 'Try 3 days free' }).length,
    ).toBeGreaterThan(1);
  });

  it('renders large plan lists progressively', async () => {
    answer({
      contactUrl: null,
      plans: Array.from({ length: 8 }, (_, index) => ({
        code: `plan-${index}`,
        name: `Plan ${index}`,
        priceMinor: '1000',
        currency: 'UZS',
        periodDays: 30,
        limits: {},
      })),
    });
    view();
    expect(await screen.findAllByTestId('site-plan')).toHaveLength(6);
    fireEvent.click(screen.getByTestId('site-plans-more'));
    expect(screen.getAllByTestId('site-plan')).toHaveLength(8);
    expect(screen.queryByTestId('site-plans-more')).toBeNull();
  });

  // Owner 2026-11-24: the page opens with the demo video, or the sample chat.
  it('opens with the demo video when there is one, else the sample chat', async () => {
    answer({
      plans: [],
      contactUrl: null,
      videoUrl: 'https://cdn.example/demo.mp4',
    });
    view();
    expect(await screen.findByTestId('site-video')).toHaveAttribute(
      'src',
      'https://cdn.example/demo.mp4',
    );
    expect(screen.queryByTestId('site-chat-demo')).toBeNull();
    cleanup();
    answer({
      plans: [],
      contactUrl: null,
      videoUrl: 'http://plain.example',
      inquiryForm: true,
    });
    view();
    expect(await screen.findByTestId('site-chat-demo')).toBeTruthy();
    expect(screen.queryByTestId('site-video')).toBeNull();
    expect(screen.getByTestId('site-results')).toBeTruthy();
    expect(await screen.findByTestId('site-contact-form')).toBeTruthy();
    // No logos until real clients agree to be shown.
    expect(screen.queryByTestId('site-clients')).toBeNull();
  });

  it('sends a signed-in person to Today', async () => {
    answer({ plans: [], contactUrl: null }, true);
    view();
    await vi.waitFor(() => expect(replace).toHaveBeenCalledWith('/today'));
  });
});
