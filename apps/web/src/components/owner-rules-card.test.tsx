import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { OwnerRulesCard, rulesFromText } from './owner-rules-card';

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('./ui/toast', () => ({ useToast: () => vi.fn() }));
vi.mock('@/lib/api', () => ({
  api: vi.fn(),
  errorKey: () => 'errors.UNKNOWN',
}));

function view(node: ReactNode): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

afterEach(() => {
  cleanup();
  vi.mocked(api).mockReset();
});

describe('owner rules (owner 2026-11-24)', () => {
  it('reads one rule per line, drops empty lines, keeps ten', () => {
    expect(rulesFromText(' a \n\n  b   c \n')).toEqual(['a', 'b c']);
    expect(rulesFromText(Array(12).fill('x').join('\n'))).toHaveLength(10);
  });

  it('loads the rules and saves the edited lines', async () => {
    vi.mocked(api).mockImplementation(
      (_path, init) =>
        Promise.resolve(
          init?.method === 'PUT' ? init.body : { rules: ['First rule'] },
        ) as never,
    );
    view(<OwnerRulesCard canChange />);
    await waitFor(() =>
      expect(screen.getByTestId('owner-rules-text')).toHaveValue('First rule'),
    );
    fireEvent.change(screen.getByTestId('owner-rules-text'), {
      target: { value: 'First rule\n\nSecond rule' },
    });
    fireEvent.click(screen.getByTestId('owner-rules-save'));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith('/api/v1/business-profile/rules', {
        method: 'PUT',
        body: { rules: ['First rule', 'Second rule'] },
      }),
    );
  });

  it('blocks more than ten rules and is read-only without the right', async () => {
    vi.mocked(api).mockResolvedValue({ rules: [] } as never);
    view(<OwnerRulesCard canChange />);
    await waitFor(() =>
      expect(screen.getByTestId('owner-rules-text')).toBeEnabled(),
    );
    fireEvent.change(screen.getByTestId('owner-rules-text'), {
      target: { value: Array(11).fill('x').join('\n') },
    });
    expect(screen.getByTestId('owner-rules-save')).toBeDisabled();
    cleanup();
    view(<OwnerRulesCard canChange={false} />);
    expect(await screen.findByTestId('owner-rules-text')).toBeDisabled();
    expect(screen.queryByTestId('owner-rules-save')).toBeNull();
  });
});
