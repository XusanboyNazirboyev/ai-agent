import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/i18n';
import { inviteUrl } from '@/lib/invite-link';
import { InviteLinkBox } from './invite-link-box';

const TOKEN = 'abcDEF123_-xyz';

describe('inviteUrl', () => {
  it('builds a link on this origin for invite paths only', () => {
    expect(inviteUrl(`/invite/${TOKEN}`, 'https://app.example.test')).toBe(
      `https://app.example.test/invite/${TOKEN}`,
    );
    expect(
      inviteUrl(`/console/invite/${TOKEN}`, 'https://app.example.test'),
    ).toBe(`https://app.example.test/console/invite/${TOKEN}`);
    expect(inviteUrl('//evil.example/x', 'https://a.test')).toBeUndefined();
    expect(inviteUrl('https://evil.example/invite/x', 'https://a.test')).toBe(
      undefined,
    );
    expect(inviteUrl('/inbox', 'https://a.test')).toBeUndefined();
  });
});

describe('InviteLinkBox', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows the full link once with a working copy button and the warning', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    render(
      <I18nProvider>
        <InviteLinkBox
          path={`/invite/${TOKEN}`}
          expiresAt="2026-11-13T10:00:00.000Z"
          email="owner@example.test"
        />
      </I18nProvider>,
    );
    const url = `${window.location.origin}/invite/${TOKEN}`;
    expect(screen.getByTestId('invite-url')).toHaveValue(url);
    expect(screen.getByText(/shown only once/u)).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByTestId('invite-copy'));
    });
    expect(writeText).toHaveBeenCalledWith(url);
    expect(screen.getByText('Copied.')).toBeInTheDocument();
  });

  it('selects the link when the clipboard is refused', async () => {
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    });
    render(
      <I18nProvider>
        <InviteLinkBox
          path={`/invite/${TOKEN}`}
          expiresAt="2026-11-13T10:00:00.000Z"
          email="owner@example.test"
        />
      </I18nProvider>,
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('invite-copy'));
    });
    expect(screen.getByText(/copy it by hand/u)).toBeInTheDocument();
  });
});
