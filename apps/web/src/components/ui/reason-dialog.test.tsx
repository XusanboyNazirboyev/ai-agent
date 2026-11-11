import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ReasonDialog } from './reason-dialog';

vi.mock('@/i18n', () => ({
  useI18n: () => ({ t: (k: string) => k }),
}));

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close() {
    this.open = false;
  };
});

afterEach(() => cleanup());

describe('ReasonDialog', () => {
  it('blocks submit for short/empty reason and confirms with trimmed reason', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ReasonDialog
        open
        testId="status-dialog"
        title="t"
        body="b"
        confirmLabel="ok"
        busy={false}
        error={undefined}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    const confirm = screen.getByTestId('reason-confirm');
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByTestId('reason-input'), {
      target: { value: '  ' },
    });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByTestId('reason-input'), {
      target: { value: ' ab ' },
    });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByTestId('reason-input'), {
      target: { value: '  valid reason  ' },
    });
    expect(confirm).not.toBeDisabled();
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith('valid reason');
    fireEvent.click(screen.getByTestId('reason-cancel'));
    expect(onCancel).toHaveBeenCalled();
  });
});
