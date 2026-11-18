import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import type { AuditLogPage as Page } from '@/lib/types';
import { AuditLogPage } from './audit-log-page';

let currentRole = 'OWNER';

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    // Known keys come back translated; unknown keys come back as the key,
    // as the real catalog lookup does.
    t: (key: string, values?: Record<string, unknown>) =>
      key === 'audit.a.lead.stage.moved'
        ? 'Lead moved'
        : key === 'audit.by'
          ? `By ${String(values?.actor)}`
          : key,
    formatDateTime: () => 'date',
  }),
}));

vi.mock('./app-shell', () => ({
  useShell: () => ({
    operator: { id: 'op1', displayName: 'Op', role: currentRole },
    timeZone: 'UTC',
  }),
}));

vi.mock('./settings-section-nav', () => ({
  SettingsSubPage: ({ children }: { children: ReactNode }) => children,
}));

vi.mock('@/lib/api', () => ({ api: vi.fn() }));

const page: Page = {
  page: 1,
  pageSize: 50,
  total: 3,
  events: [
    {
      id: 'e1',
      action: 'lead.stage.moved',
      category: 'leads',
      actorType: 'OPERATOR',
      actor: 'Malika',
      entityType: 'lead',
      entityId: 'l1',
      summary: { stage: 's2', nested: { no: 1 } },
      createdAt: '2026-11-18T10:00:00.000Z',
    },
    {
      id: 'e2',
      action: 'something.new',
      category: 'other',
      actorType: 'SYSTEM',
      actor: null,
      entityType: 'x',
      entityId: 'x',
      summary: {},
      createdAt: '2026-11-18T09:00:00.000Z',
    },
    {
      id: 'e3',
      action: 'operator.reply',
      category: 'conversations',
      actorType: 'OPERATOR',
      actor: null,
      entityType: 'conversation',
      entityId: 'c1',
      summary: {},
      createdAt: '2026-11-18T08:00:00.000Z',
    },
  ],
};

function show(): void {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <AuditLogPage />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.mocked(api).mockReset();
  currentRole = 'OWNER';
});

describe('Settings → History (ADR 074)', () => {
  it('shows labelled rows, the actor or who it was, and safe summaries', async () => {
    vi.mocked(api).mockResolvedValue(page);
    show();
    const rows = await screen.findAllByTestId('audit-row');
    expect(rows).toHaveLength(3);
    expect(rows[0]!.textContent).toContain('Lead moved');
    expect(rows[0]!.textContent).toContain('By Malika');
    expect(rows[0]!.textContent).toContain('stage: s2');
    expect(rows[0]!.textContent).not.toContain('nested');
    // An action without a label shows its code instead of a missing key.
    expect(rows[1]!.textContent).toContain('something.new');
    expect(rows[1]!.textContent).toContain('By audit.actor.system');
    expect(rows[2]!.textContent).toContain('By audit.actor.removed');
    expect(vi.mocked(api)).toHaveBeenCalledWith(
      '/api/v1/audit-events?page=1&pageSize=50',
    );
  });

  it('filters by category from the first page', async () => {
    vi.mocked(api).mockResolvedValue(page);
    show();
    await screen.findAllByTestId('audit-row');
    fireEvent.change(screen.getByTestId('audit-category'), {
      target: { value: 'leads' },
    });
    await waitFor(() =>
      expect(vi.mocked(api)).toHaveBeenLastCalledWith(
        '/api/v1/audit-events?page=1&pageSize=50&category=leads',
      ),
    );
  });

  it('operators see a note and nothing is requested', () => {
    currentRole = 'OPERATOR';
    show();
    expect(screen.getByRole('status').textContent).toBe('team.managersOnly');
    expect(vi.mocked(api)).not.toHaveBeenCalled();
  });
});
