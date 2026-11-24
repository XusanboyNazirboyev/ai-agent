import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/i18n';
import { api } from '@/lib/api';
import { phoneLooksValid, SiteContactForm } from './site-contact-form';

vi.mock('@/lib/api', async (actual) => ({
  ...(await actual<typeof import('@/lib/api')>()),
  api: vi.fn(),
}));

function view(telegramUrl: string | null = null): void {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider>
        <SiteContactForm telegramUrl={telegramUrl} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.mocked(api).mockReset();
});

describe('SiteContactForm (owner 2026-11-24)', () => {
  it('sends name, phone and company, then thanks the visitor', async () => {
    vi.mocked(api).mockResolvedValue({ ok: true } as never);
    view('https://t.me/tezda');
    expect(screen.getByTestId('site-contact')).toHaveAttribute(
      'href',
      'https://t.me/tezda',
    );
    fireEvent.change(screen.getByTestId('site-contact-name'), {
      target: { value: 'Ali' },
    });
    fireEvent.change(screen.getByTestId('site-contact-phone'), {
      target: { value: '+998 90 123 45 67' },
    });
    fireEvent.change(screen.getByLabelText('Company (optional)'), {
      target: { value: 'Sayohat' },
    });
    fireEvent.click(screen.getByTestId('site-contact-submit'));
    expect(await screen.findByTestId('site-contact-done')).toBeTruthy();
    expect(api).toHaveBeenCalledWith('/api/v1/public/inquiries', {
      method: 'POST',
      body: expect.objectContaining({
        name: 'Ali',
        phone: '+998 90 123 45 67',
        company: 'Sayohat',
        website: '',
      }),
    });
  });

  it('asks for a name and a phone before sending anything', () => {
    view();
    fireEvent.change(screen.getByTestId('site-contact-name'), {
      target: { value: 'Ali' },
    });
    fireEvent.change(screen.getByTestId('site-contact-phone'), {
      target: { value: 'call me' },
    });
    fireEvent.click(screen.getByTestId('site-contact-submit'));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Enter your name and a phone number.',
    );
    expect(api).not.toHaveBeenCalled();
    expect(screen.queryByTestId('site-contact')).toBeNull();
  });

  it('accepts the phone shapes the API accepts', () => {
    expect(phoneLooksValid('+998 (90) 123-45-67')).toBe(true);
    expect(phoneLooksValid('12345')).toBe(false);
    expect(phoneLooksValid('+998 90 abc')).toBe(false);
  });
});
