import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MfaCodeForm,
  MfaEnrollForm,
  MfaSecurityPanel,
  type MfaCall,
} from './mfa';

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      key === 'mfa.recovery.remaining'
        ? `remaining:${String(values?.count)}`
        : key,
  }),
}));

vi.mock('@/lib/api', () => ({
  errorKey: (e: unknown) => (e instanceof Error ? e.message : 'errors.UNKNOWN'),
}));

Object.assign(navigator, {
  clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
});

function wrap(node: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{node}</QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('MFA UI components', () => {
  it('MfaCodeForm submits code or recovery code', () => {
    const onSubmit = vi.fn();
    render(<MfaCodeForm onSubmit={onSubmit} busy={false} error={undefined} />);
    fireEvent.change(screen.getByTestId('mfa-code'), {
      target: { value: '123456' },
    });
    fireEvent.submit(screen.getByTestId('mfa-form'));
    expect(onSubmit).toHaveBeenCalledWith({ code: '123456' });

    cleanup();
    const onSubmit2 = vi.fn();
    render(<MfaCodeForm onSubmit={onSubmit2} busy={false} error={undefined} />);
    fireEvent.click(screen.getByTestId('mfa-toggle-recovery'));
    fireEvent.change(screen.getByTestId('mfa-code'), {
      target: { value: 'recovery-1' },
    });
    fireEvent.submit(screen.getByTestId('mfa-form'));
    expect(onSubmit2).toHaveBeenCalledWith({ recoveryCode: 'recovery-1' });
  });

  it('MfaEnrollForm submits entered code', () => {
    const onSubmit = vi.fn();
    render(
      <MfaEnrollForm
        setup={{ secret: 'SECRET', otpauthUri: 'otpauth://x' }}
        onSubmit={onSubmit}
        busy={false}
        error={undefined}
      />,
    );
    expect(screen.getByTestId('mfa-secret')).toHaveValue('SECRET');
    fireEvent.change(screen.getByTestId('mfa-enroll-code'), {
      target: { value: '654321' },
    });
    fireEvent.submit(screen.getByTestId('mfa-enroll'));
    expect(onSubmit).toHaveBeenCalledWith('654321');
  });

  it('MfaSecurityPanel starts setup, enables and shows recovery codes', async () => {
    const call: MfaCall = vi.fn(
      async (path: string, options?: { method?: string }) => {
        if (path === '/pfx' && !options?.method)
          return {
            available: true,
            enabled: false,
            pending: false,
            recoveryCodesRemaining: 0,
            required: false,
          };
        if (path === '/pfx/setup' && options?.method === 'POST')
          return { secret: 'S', otpauthUri: 'otpauth://x' };
        if (path === '/pfx/enable' && options?.method === 'POST')
          return { recoveryCodes: ['r1', 'r2'] };
        throw new Error(`unexpected ${path}`);
      },
    ) as MfaCall;

    wrap(<MfaSecurityPanel call={call} prefix="/pfx" queryKey={['mfa']} />);
    fireEvent.click(await screen.findByTestId('mfa-start'));
    expect(await screen.findByTestId('mfa-enroll')).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('mfa-enroll-code'), {
      target: { value: '111111' },
    });
    fireEvent.submit(screen.getByTestId('mfa-enroll'));
    expect(await screen.findByTestId('mfa-recovery')).toBeInTheDocument();
    expect(screen.getByText('r1')).toBeInTheDocument();
  });

  it('MfaSecurityPanel regenerates and disables when enabled and not required', async () => {
    const call: MfaCall = vi.fn(
      async (path: string, options?: { method?: string; body?: unknown }) => {
        if (path === '/pfx' && !options?.method)
          return {
            available: true,
            enabled: true,
            pending: false,
            recoveryCodesRemaining: 2,
            required: false,
          };
        if (path === '/pfx/recovery-codes' && options?.method === 'POST')
          return { recoveryCodes: ['n1'] };
        if (path === '/pfx/disable' && options?.method === 'POST') return {};
        throw new Error(`unexpected ${path}`);
      },
    ) as MfaCall;

    wrap(<MfaSecurityPanel call={call} prefix="/pfx" queryKey={['mfa2']} />);
    await screen.findByTestId('mfa-manage');
    expect(screen.getByTestId('mfa-state')).toHaveTextContent('mfa.state.on');
    fireEvent.change(screen.getByTestId('mfa-manage-code'), {
      target: { value: '222222' },
    });
    fireEvent.click(screen.getByTestId('mfa-regenerate'));
    expect(await screen.findByTestId('mfa-recovery')).toBeInTheDocument();

    cleanup();
    wrap(<MfaSecurityPanel call={call} prefix="/pfx" queryKey={['mfa3']} />);
    await screen.findByTestId('mfa-manage');
    fireEvent.change(screen.getByTestId('mfa-manage-password'), {
      target: { value: 'passw0rdlong' },
    });
    fireEvent.change(screen.getByTestId('mfa-manage-code'), {
      target: { value: '333333' },
    });
    fireEvent.click(screen.getByTestId('mfa-disable'));
    await waitFor(() => {
      expect(call).toHaveBeenCalledWith(
        '/pfx/disable',
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });
});
