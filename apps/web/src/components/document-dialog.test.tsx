import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/i18n';
import { DocumentDialog } from './document-dialog';

const LIMITS = { text: 40_000, title: 150 };
const TITLE = 'Refund policy';
const TEXT = 'Refunds are possible within 14 days.';

beforeAll(() => {
  // jsdom has no modal dialog support; open/close is all the dialog needs.
  HTMLDialogElement.prototype.showModal = function showModal(): void {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close(): void {
    this.open = false;
  };
});

function dialog(open: boolean): ReactNode {
  return (
    <I18nProvider>
      <DocumentDialog
        open={open}
        limits={LIMITS}
        busy={false}
        error={null}
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />
    </I18nProvider>
  );
}

describe('DocumentDialog (DEF-019)', () => {
  it('forgets the last draft as soon as it closes, so a reopened dialog never shows stale values', () => {
    const view = render(dialog(true));
    fireEvent.change(screen.getByTestId('document-title'), {
      target: { value: TITLE },
    });
    fireEvent.change(screen.getByTestId('document-text'), {
      target: { value: TEXT },
    });
    expect(screen.getByTestId('document-title')).toHaveValue(TITLE);

    // Closed (saved or cancelled): nothing of the old draft may remain, or a
    // reopen shows it until the deferred reset render, and typing the same
    // title again is swallowed by React (the DOM value does not change).
    view.rerender(dialog(false));
    expect(screen.getByTestId('document-title')).toHaveValue('');
    expect(screen.getByTestId('document-text')).toHaveValue('');

    view.rerender(dialog(true));
    fireEvent.change(screen.getByTestId('document-title'), {
      target: { value: TITLE },
    });
    expect(screen.getByTestId('document-title')).toHaveValue(TITLE);
  });
});
