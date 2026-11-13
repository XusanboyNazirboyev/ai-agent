import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { PipelinesSettingsPage } from './pipelines-settings-page';

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${JSON.stringify(values)}` : key,
    formatDateTime: () => 'date',
  }),
}));

vi.mock('./ui/toast', () => ({ useToast: () => vi.fn() }));
vi.mock('./settings-section-nav', () => ({
  SettingsSubPage: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

let role = 'OWNER';
vi.mock('./app-shell', () => ({
  useShell: () => ({
    operator: { id: 'op1', displayName: 'Op', role },
    timeZone: 'UTC',
  }),
}));

vi.mock('@/lib/api', () => ({
  api: vi.fn(),
  errorKey: (e: unknown) => String(e),
}));

const pipeline = {
  id: 'p1',
  name: 'Sales',
  position: 0,
  isDefault: true,
  stageCount: 2,
  leadCount: 0,
};
const stages = [
  { id: 's1', code: 'NEW', name: null, position: 0, pipelineId: 'p1' },
  { id: 's2', code: null, name: 'Custom', position: 1, pipelineId: 'p1' },
];

function setup(overrides: Record<string, unknown> = {}) {
  const mocked = vi.mocked(api);
  mocked.mockImplementation(((
    path: string,
    opts?: { method?: string; body?: unknown },
  ) => {
    const body = opts?.body as Record<string, unknown> | undefined;
    if (path === '/api/v1/pipelines' && !opts)
      return Promise.resolve({ items: [pipeline] });
    if (path.startsWith('/api/v1/leads/stages')) return Promise.resolve(stages);
    if (path === '/api/v1/pipelines' && opts?.method === 'POST')
      return Promise.resolve({
        ...pipeline,
        id: 'p2',
        name: String(body?.name ?? ''),
      });
    if (path === '/api/v1/pipelines/p1' && opts?.method === 'PATCH')
      return Promise.resolve({
        ...pipeline,
        name: String(body?.name ?? pipeline.name),
      });
    if (path === '/api/v1/pipelines/p1/make-default')
      return Promise.resolve({ items: [pipeline] });
    if (path === '/api/v1/pipelines/p1' && opts?.method === 'DELETE')
      return Promise.resolve({ id: 'p1', archived: true });
    if (path === '/api/v1/leads/stages' && opts?.method === 'POST')
      return Promise.resolve({
        id: 's3',
        code: null,
        name: String(body?.name ?? ''),
        position: 2,
        pipelineId: 'p1',
      });
    if (path === '/api/v1/leads/stages/s2' && opts?.method === 'PATCH')
      return Promise.resolve({
        ...stages[1],
        name: String(body?.name ?? stages[1].name),
      });
    if (path === '/api/v1/leads/stages/s2' && opts?.method === 'DELETE')
      return Promise.resolve({ id: 's2', deleted: true });
    if (path === '/api/v1/pipelines/p1/stages/order')
      return Promise.resolve(stages);
    return Promise.resolve(overrides[path] ?? {});
  }) as unknown as Parameters<typeof mocked.mockImplementation>[0]);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <PipelinesSettingsPage />
    </QueryClientProvider>,
  );
  return mocked;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  role = 'OWNER';
});

describe('PipelinesSettingsPage', () => {
  it('renders pipelines list', async () => {
    setup();
    expect(await screen.findByTestId('pipelines-list')).toBeInTheDocument();
    expect(screen.getByText('Sales')).toBeInTheDocument();
  });

  it('hides management buttons for OPERATOR', async () => {
    role = 'OPERATOR';
    setup();
    await screen.findByTestId('pipelines-list');
    expect(screen.queryByTestId('pipeline-create')).toBeNull();
  });
});
