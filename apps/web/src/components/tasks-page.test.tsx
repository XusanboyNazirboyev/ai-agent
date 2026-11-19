import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { TasksPage } from './tasks-page';

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, values?: Record<string, string | number>) =>
      values ? `${key}|${Object.values(values).join(',')}` : key,
    formatDateTime: () => 'date',
  }),
}));
let role = 'OPERATOR';
vi.mock('./app-shell', () => ({
  useShell: () => ({
    operator: { id: 'op1', displayName: 'Op', role },
    timeZone: 'UTC',
  }),
}));
vi.mock('next/link', () => ({
  default: (p: { href: string; children: React.ReactNode }) => (
    <a href={p.href}>{p.children}</a>
  ),
}));
vi.mock('@/lib/api', () => ({
  api: vi.fn(),
  errorKey: () => 'errors.UNKNOWN',
}));

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal(): void {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(): void {
    this.removeAttribute('open');
  };
});

const task = (over: Record<string, unknown> = {}) => ({
  id: 't1',
  leadId: 'lead-1',
  title: 'Call Ali',
  dueAt: '2031-01-01T10:00:00.000Z',
  remindAt: null,
  assignee: { id: 'op1', displayName: 'Op' },
  doneAt: null,
  overdue: false,
  contactName: 'Ali',
  ...over,
});
const page = (items = [task()]) => ({
  items,
  nextCursor: null,
  counts: { overdue: 2, today: 1, upcoming: 3, done: 4 },
});
const calls = (): string[] =>
  vi.mocked(api).mock.calls.map((c) => String(c[0]));

function setup(): void {
  vi.mocked(api).mockImplementation((path: string, options?: unknown) => {
    if (path.startsWith('/api/v1/tasks?'))
      return Promise.resolve(page()) as never;
    if (path === '/api/v1/team')
      return Promise.resolve({
        operators: [{ id: 'op1', displayName: 'Op', isActive: true }],
      }) as never;
    if (path.startsWith('/api/v1/leads?'))
      return Promise.resolve({
        items: [
          {
            id: 'lead-1',
            contact: { name: 'Ali Valiev', phone: '+998901234567' },
          },
        ],
        nextCursor: null,
      }) as never;
    void options;
    return Promise.resolve({}) as never;
  });
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <TasksPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  role = 'OPERATOR';
  vi.mocked(api).mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('TasksPage', () => {
  it('shows the counts, links the lead, and switches segment and scope', async () => {
    setup();
    expect(await screen.findByText('Call Ali')).toBeTruthy();
    expect(screen.getByTestId('tasks-count-overdue').textContent).toBe('2');
    expect(screen.getByTestId('tasks-count-done').textContent).toBe('4');
    expect(screen.getByRole('link', { name: 'Ali' }).getAttribute('href')).toBe(
      '/leads/lead-1',
    );
    expect(
      calls().some(
        (c) => c.includes('scope=mine') && c.includes('status=today'),
      ),
    ).toBe(true);
    fireEvent.click(screen.getByTestId('tasks-segment-overdue'));
    await waitFor(() =>
      expect(calls().some((c) => c.includes('status=overdue'))).toBe(true),
    );
    fireEvent.click(screen.getByTestId('tasks-scope-all'));
    await waitFor(() =>
      expect(calls().some((c) => c.includes('scope=all'))).toBe(true),
    );
    // An operator gets no assignee filter.
    expect(screen.queryByTestId('tasks-assignee-filter')).toBeNull();
  });

  it('lets an owner filter by assignee when scope is Everyone', async () => {
    role = 'OWNER';
    setup();
    await screen.findByText('Call Ali');
    fireEvent.click(screen.getByTestId('tasks-scope-all'));
    fireEvent.change(await screen.findByTestId('tasks-assignee-filter'), {
      target: { value: 'op1' },
    });
    await waitFor(() =>
      expect(calls().some((c) => c.includes('assigneeId=op1'))).toBe(true),
    );
  });

  it('finishes a task with the checkbox', async () => {
    setup();
    await screen.findByText('Call Ali');
    fireEvent.click(screen.getByRole('checkbox'));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith('/api/v1/tasks/t1', {
        method: 'PATCH',
        body: { done: true },
      }),
    );
  });

  it('creates a task for a lead found by search (debounced)', async () => {
    setup();
    await screen.findByText('Call Ali');
    fireEvent.click(screen.getByTestId('task-new'));
    fireEvent.change(screen.getByTestId('task-lead-search'), {
      target: { value: 'ali' },
    });
    expect(calls().some((c) => c.startsWith('/api/v1/leads?'))).toBe(false);
    fireEvent.click(await screen.findByTestId('task-lead-option'));
    expect(screen.getByTestId('task-lead-selected').textContent).toBe(
      'Ali Valiev',
    );
    fireEvent.change(screen.getByTestId('task-form-title'), {
      target: { value: 'Send offer' },
    });
    fireEvent.change(screen.getByTestId('task-form-due'), {
      target: { value: '2031-02-03T09:00' },
    });
    fireEvent.change(screen.getByTestId('task-form-remind'), {
      target: { value: '60' },
    });
    fireEvent.click(screen.getByTestId('task-save'));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        '/api/v1/leads/lead-1/tasks',
        expect.objectContaining({
          method: 'POST',
          body: expect.objectContaining({
            title: 'Send offer',
            assigneeId: 'op1',
            remindBefore: 60,
          }),
        }),
      ),
    );
  });

  it('is read-only for a viewer', async () => {
    role = 'VIEWER';
    setup();
    await screen.findByText('Call Ali');
    expect(screen.queryByTestId('task-new')).toBeNull();
    expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(
      true,
    );
    expect(screen.queryByLabelText('tasks.editTask|Call Ali')).toBeNull();
    expect(screen.queryByLabelText('tasks.deleteTask|Call Ali')).toBeNull();
  });

  it('shows the empty state', async () => {
    vi.mocked(api).mockResolvedValue({
      items: [],
      nextCursor: null,
      counts: { overdue: 0, today: 0, upcoming: 0, done: 0 },
    } as never);
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <TasksPage />
      </QueryClientProvider>,
    );
    expect(await screen.findByTestId('tasks-empty')).toBeTruthy();
  });
});
