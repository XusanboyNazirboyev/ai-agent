import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  channelsQuery,
  conversationsQuery,
  waitingCountQuery,
} from '@/lib/queries';
import type { ChannelAccount } from '@/lib/types';
import { ConversationList } from './conversation-list';

vi.mock('@/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

afterEach(cleanup);

describe('inbox channel chip rendering', () => {
  it('shows the filter when only one messenger is connected', () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    const telegram = {
      id: 'telegram-1',
      channelType: 'telegram',
      displayName: 'Telegram',
    } as ChannelAccount;
    const page = { items: [], nextCursor: null };
    client.setQueryData(channelsQuery.queryKey, { items: [telegram] });
    client.setQueryData(waitingCountQuery.queryKey, page);
    client.setQueryData(
      conversationsQuery({
        scope: 'all',
        q: '',
        language: '',
        score: '',
        tagId: '',
        channelType: '',
      }).queryKey,
      { pages: [page], pageParams: [''] },
    );

    render(
      <QueryClientProvider client={client}>
        <ConversationList
          scope="all"
          selectedId={null}
          waitingCount={0}
          onScope={vi.fn()}
          onSelect={vi.fn()}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByTestId('inbox-channels')).toBeTruthy();
    expect(screen.getByTestId('inbox-channel-telegram')).toBeTruthy();
  });
});
