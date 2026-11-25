import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PasswordInput } from './password-input';

vi.mock('@/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

afterEach(cleanup);

describe('PasswordInput (owner 2026-11-25)', () => {
  it('starts hidden, shows and hides on the button, and never submits the form', () => {
    const submit = vi.fn((event: Event) => event.preventDefault());
    render(
      <form onSubmit={(event) => submit(event.nativeEvent)}>
        <label>
          Password
          <PasswordInput name="password" defaultValue="s3cret" />
        </label>
      </form>,
    );
    const input = screen.getByLabelText('Password');
    expect(input).toHaveProperty('type', 'password');
    const toggle = screen.getByRole('button', { name: 'password.show' });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(toggle);
    expect(input).toHaveProperty('type', 'text');
    const hide = screen.getByRole('button', { name: 'password.hide' });
    expect(hide.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(hide);
    expect(input).toHaveProperty('type', 'password');
    expect(submit).not.toHaveBeenCalled();
  });
});
