import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/i18n';
import { SetupGuide } from './setup-guide';
import { SignupPage } from './signup-page';

const replace = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace }) }));

const checklist = {
  channelConnected: false,
  hasContent: false,
  teamInvited: false,
  operatorGroup: false,
  testedAssistant: false,
  selfSignup: true,
};

let statuses: unknown[] = [];
let posts: unknown[] = [];

beforeEach(() => {
  statuses = [{ status: 'PENDING' }];
  posts = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: { method?: string; body?: string }) => {
      const reply = (status: number, body: unknown): Promise<unknown> =>
        Promise.resolve({
          ok: status < 400,
          status,
          text: () => Promise.resolve(JSON.stringify(body)),
        });
      if (url.includes('/auth/me')) return reply(401, {});
      if (url.includes('/public/plans'))
        return reply(200, { plans: [{ code: 'premium', name: 'Premium' }] });
      if (init?.method === 'POST') {
        posts.push(JSON.parse(init.body ?? '{}'));
        return reply(201, {
          id: '11111111-1111-4111-8111-111111111111',
          telegramUrl: 'https://t.me/tezda_bot?start=tok',
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
        });
      }
      return reply(200, statuses.length > 1 ? statuses.shift() : statuses[0]);
    }),
  );
  window.history.replaceState(null, '', '/signup?plan=basic');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  replace.mockClear();
});

function view(node: React.ReactNode): void {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider>{node}</I18nProvider>
    </QueryClientProvider>,
  );
}

function fill(): void {
  for (const [id, value] of [
    ['signup-business', 'My Shop'],
    ['signup-type', 'travel'],
    ['signup-name', 'Ali'],
    ['signup-email', 'ali@example.com'],
    ['signup-password', '0123456789'],
  ] as const)
    fireEvent.change(screen.getByTestId(id), { target: { value } });
}

describe('SignupPage', () => {
  it('shows the plan as text and refuses an incomplete form', async () => {
    view(<SignupPage />);
    expect(await screen.findByTestId('signup-plan')).toHaveTextContent('basic');
    fireEvent.click(screen.getByTestId('signup-submit'));
    expect(await screen.findByTestId('signup-error')).toBeInTheDocument();
    expect(posts).toHaveLength(0);
  });

  it('goes to step 2, polls, and opens /today?welcome=1 once signed in', async () => {
    statuses = [{ status: 'PENDING' }, { status: 'CONFIRMED', signedIn: true }];
    view(<SignupPage />);
    await screen.findByTestId('signup-form');
    fill();
    fireEvent.click(screen.getByTestId('signup-submit'));
    const open = await screen.findByTestId('signup-telegram');
    expect(open).toHaveAttribute('href', 'https://t.me/tezda_bot?start=tok');
    expect(posts[0]).toMatchObject({
      planCode: 'basic',
      packKey: 'travel',
      email: 'ali@example.com',
    });
    await waitFor(
      () => expect(replace).toHaveBeenCalledWith('/today?welcome=1'),
      {
        timeout: 7000,
      },
    );
  }, 12000);

  it('tells the person when the trial was already used', async () => {
    statuses = [{ status: 'REFUSED', reason: 'TRIAL_USED' }];
    view(<SignupPage />);
    await screen.findByTestId('signup-form');
    fill();
    fireEvent.click(screen.getByTestId('signup-submit'));
    expect(
      await screen.findByTestId('signup-refused', undefined, { timeout: 5000 }),
    ).toBeInTheDocument();
  }, 10000);
});

describe('SignupPage business type (owner 2026-11-23)', () => {
  it('sends the general pack for any other business', async () => {
    statuses = [{ status: 'PENDING' }];
    view(<SignupPage />);
    await screen.findByTestId('signup-form');
    fill();
    fireEvent.change(screen.getByTestId('signup-type'), {
      target: { value: 'general' },
    });
    fireEvent.click(screen.getByTestId('signup-submit'));
    await screen.findByTestId('signup-telegram');
    expect(posts[0]).toMatchObject({ packKey: 'general' });
  });
});

describe('SetupGuide', () => {
  it('shows one step, skips it, and moves on', async () => {
    view(<SetupGuide checklist={checklist} light="none" welcome={false} />);
    expect(
      await screen.findByTestId('setup-guide-business'),
    ).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByTestId('setup-guide-skip'));
    });
    expect(screen.getByTestId('setup-guide-channel')).toBeInTheDocument();
    expect(screen.getByTestId('setup-guide-progress')).toHaveTextContent(
      '0 of 5',
    );
  });

  it('stays hidden for an ordinary workspace', async () => {
    view(
      <SetupGuide
        checklist={{ ...checklist, selfSignup: false }}
        light="none"
        welcome={false}
      />,
    );
    await waitFor(() => expect(screen.queryByTestId('setup-guide')).toBeNull());
  });

  it('shows for ?welcome=1 and uses the server state for done steps', async () => {
    view(
      <SetupGuide
        checklist={{ ...checklist, selfSignup: false, channelConnected: true }}
        light="none"
        welcome
      />,
    );
    expect(await screen.findByTestId('setup-guide-progress')).toHaveTextContent(
      '1 of 5',
    );
  });
});
