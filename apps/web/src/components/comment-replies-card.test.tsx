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
import type { ChannelAccount } from '@/lib/types';
import { CommentRepliesCard, keywordsFromText } from './comment-replies-card';

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('./ui/toast', () => ({ useToast: () => vi.fn() }));
vi.mock('@/lib/api', () => ({
  api: vi.fn(),
  errorKey: () => 'errors.UNKNOWN',
}));

const account = {
  id: 'a1',
  channelType: 'instagram',
  displayName: '@shop',
  commentReplies: false,
  commentKeywords: [],
} as unknown as ChannelAccount;

function view(node: ReactNode): void {
  render(
    <QueryClientProvider client={new QueryClient()}>
      {node}
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.mocked(api).mockReset();
});

describe('comment auto-replies card (owner 2026-11-24)', () => {
  it('reads words split by commas or lines, lower-case, without repeats', () => {
    expect(keywordsFromText(' Narx, narx\nPrice ,, ')).toEqual([
      'narx',
      'price',
    ]);
  });

  it('turns replies on with the words for that account', async () => {
    vi.mocked(api).mockResolvedValue(account as never);
    view(<CommentRepliesCard account={account} canManage />);
    fireEvent.click(screen.getByTestId('comment-replies-toggle'));
    fireEvent.change(screen.getByTestId('comment-replies-words'), {
      target: { value: 'narx, qancha' },
    });
    fireEvent.click(screen.getByTestId('comment-replies-save'));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        '/api/v1/channels/instagram/a1/comment-replies',
        {
          method: 'PUT',
          body: { enabled: true, keywords: ['narx', 'qancha'] },
        },
      ),
    );
  });

  it('is read-only for operators', () => {
    view(<CommentRepliesCard account={account} canManage={false} />);
    expect(screen.getByTestId('comment-replies-toggle')).toBeDisabled();
    expect(screen.queryByTestId('comment-replies-save')).toBeNull();
  });
});
