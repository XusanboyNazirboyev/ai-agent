import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '@/lib/api';
import { LoginForm } from './login-form';

const replace = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace }),
}));

vi.mock('@/i18n', () => ({
  useI18n: () => ({ t: (k: string) => k }),
}));

vi.mock('@/lib/api', () => {
  class MockApiError extends Error {
    constructor(
      readonly status: number,
      readonly code: string,
    ) {
      super(code);
    }
  }
  return {
    api: vi.fn(),
    ApiError: MockApiError,
    errorKey: (e: unknown) =>
      e instanceof MockApiError ? `errors.${e.code}` : 'errors.UNKNOWN',
  };
});

vi.mock('./locale-switcher', () => ({ LocaleSwitcher: () => <div /> }));
vi.mock('./legal-page', () => ({ LegalLinks: () => <div /> }));
vi.mock('./ui/brand', () => ({ BrandLogo: () => <div /> }));
vi.mock('./mfa', () => ({
  MfaCodeForm: (props: {
    onSubmit: (f: { code: string }) => void;
    error?: string;
  }) => (
    <form
      data-testid="mfa-form"
      onSubmit={(e) => {
        e.preventDefault();
        props.onSubmit({ code: '123456' });
      }}
    >
      {props.error ? <p data-testid="mfa-error">{props.error}</p> : null}
      <button type="submit">ok</button>
    </form>
  ),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('LoginForm', () => {
  it('submits credentials and redirects on success', async () => {
    vi.mocked(api).mockResolvedValue({});
    render(<LoginForm />);
    fireEvent.change(screen.getByLabelText('login.email'), {
      target: { value: 'a@b.c' },
    });
    fireEvent.change(screen.getByLabelText('login.password'), {
      target: { value: 'pw' },
    });
    fireEvent.submit(
      screen.getByRole('button', { name: 'login.submit' }).closest('form')!,
    );
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/inbox'));
  });

  it('shows MFA step only when API asks for it and completes MFA login', async () => {
    vi.mocked(api)
      .mockResolvedValueOnce({ mfaRequired: true, challenge: 'ch1' })
      .mockResolvedValueOnce({});
    render(<LoginForm />);
    fireEvent.change(screen.getByLabelText('login.email'), {
      target: { value: 'a@b.c' },
    });
    fireEvent.change(screen.getByLabelText('login.password'), {
      target: { value: 'pw' },
    });
    fireEvent.submit(
      screen.getByRole('button', { name: 'login.submit' }).closest('form')!,
    );
    expect(await screen.findByTestId('mfa-form')).toBeInTheDocument();
    fireEvent.submit(screen.getByTestId('mfa-form'));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith('/api/v1/auth/login/mfa', {
        method: 'POST',
        body: { challenge: 'ch1', code: '123456' },
      }),
    );
    expect(replace).toHaveBeenCalledWith('/inbox');
  });

  it('maps login errors', async () => {
    vi.mocked(api).mockRejectedValue(new ApiError(401, 'INVALID_CREDENTIALS'));
    render(<LoginForm />);
    fireEvent.change(screen.getByLabelText('login.email'), {
      target: { value: 'a@b.c' },
    });
    fireEvent.change(screen.getByLabelText('login.password'), {
      target: { value: 'pw' },
    });
    fireEvent.submit(
      screen.getByRole('button', { name: 'login.submit' }).closest('form')!,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'errors.INVALID_CREDENTIALS',
    );
  });
});
