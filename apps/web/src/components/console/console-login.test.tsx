import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, platformApi } from '@/lib/api';
import { ConsoleLogin } from './console-login';

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
    platformApi: vi.fn(),
    ApiError: MockApiError,
    errorKey: (e: unknown) =>
      e instanceof MockApiError ? `errors.${e.code}` : 'errors.UNKNOWN',
  };
});

vi.mock('../auth-card', () => ({
  AuthCard: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock('../ui/badge', () => ({ Badge: () => <span /> }));
vi.mock('../mfa', () => ({
  MfaCodeForm: (props: {
    onSubmit: (f: { code: string }) => void;
    error?: string;
  }) => (
    <form
      data-testid="mfa-form"
      onSubmit={(e) => {
        e.preventDefault();
        props.onSubmit({ code: '111111' });
      }}
    >
      {props.error ? <p data-testid="mfa-error">{props.error}</p> : null}
      <button type="submit">ok</button>
    </form>
  ),
  MfaEnrollForm: (props: {
    onSubmit: (code: string) => void;
    error?: string;
  }) => (
    <form
      data-testid="mfa-enroll"
      onSubmit={(e) => {
        e.preventDefault();
        props.onSubmit('222222');
      }}
    >
      {props.error ? <p data-testid="enroll-error">{props.error}</p> : null}
      <button type="submit">ok</button>
    </form>
  ),
  RecoveryCodes: ({ onDone }: { onDone: () => void }) => (
    <button data-testid="recovery-done" onClick={onDone}>
      done
    </button>
  ),
}));

function renderLogin() {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ConsoleLogin />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ConsoleLogin', () => {
  it('maps login errors and logs in on success', async () => {
    vi.mocked(platformApi).mockRejectedValueOnce(new ApiError(401, 'BAD'));
    renderLogin();
    fireEvent.change(screen.getByLabelText('login.email'), {
      target: { value: 'a@b.c' },
    });
    fireEvent.change(screen.getByLabelText('login.password'), {
      target: { value: 'pw' },
    });
    fireEvent.submit(
      screen.getByRole('button', { name: 'login.submit' }).closest('form')!,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('errors.BAD');

    cleanup();
    vi.mocked(platformApi).mockResolvedValueOnce({});
    renderLogin();
    fireEvent.change(screen.getByLabelText('login.email'), {
      target: { value: 'a@b.c' },
    });
    fireEvent.change(screen.getByLabelText('login.password'), {
      target: { value: 'pw' },
    });
    fireEvent.submit(
      screen.getByRole('button', { name: 'login.submit' }).closest('form')!,
    );
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/console'));
  });

  it('shows MFA code step only when requested and finishes', async () => {
    vi.mocked(platformApi)
      .mockResolvedValueOnce({ mfaRequired: true, challenge: 'ch' })
      .mockResolvedValueOnce({});
    renderLogin();
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
      expect(platformApi).toHaveBeenCalledWith(
        '/api/v1/platform/auth/login/mfa',
        {
          method: 'POST',
          body: { challenge: 'ch', code: '111111' },
        },
      ),
    );
    expect(replace).toHaveBeenCalledWith('/console');
  });

  it('handles enrollment-required flow and shows recovery codes', async () => {
    vi.mocked(platformApi)
      .mockResolvedValueOnce({ mfaEnrollmentRequired: true, challenge: 'ch2' })
      .mockResolvedValueOnce({ secret: 'S', otpauthUri: 'otpauth://x' })
      .mockResolvedValueOnce({ recoveryCodes: ['r1'] });
    renderLogin();
    fireEvent.change(screen.getByLabelText('login.email'), {
      target: { value: 'a@b.c' },
    });
    fireEvent.change(screen.getByLabelText('login.password'), {
      target: { value: 'pw' },
    });
    fireEvent.submit(
      screen.getByRole('button', { name: 'login.submit' }).closest('form')!,
    );
    expect(await screen.findByTestId('mfa-enroll')).toBeInTheDocument();
    fireEvent.submit(screen.getByTestId('mfa-enroll'));
    expect(await screen.findByTestId('recovery-done')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('recovery-done'));
    expect(replace).toHaveBeenCalledWith('/console');
  });
});
