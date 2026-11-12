import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import type { PersonDetail, Role } from '@/lib/types';
import { PersonCustomFieldsSection, PersonTagsSection } from './person-tags-fields';

const toastMock = vi.fn();

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, values?: Record<string, unknown>) => {
      if (key === 'people.removeTag') return `remove:${String(values?.name)}`;
      if (key.startsWith('errors.')) return key;
      if (key.startsWith('toast.')) return key;
      return key;
    },
  }),
}));
vi.mock('./ui/toast', () => ({ useToast: () => toastMock }));
vi.mock('@/lib/api', () => ({
  api: vi.fn(),
  errorKey: (e: unknown) =>
    e && typeof e === 'object' && 'code' in e
      ? `errors.${String((e as { code: string }).code)}`
      : 'errors.UNKNOWN',
}));

function basePerson(): PersonDetail {
  return {
    id: 'p1',
    displayName: 'Ada',
    phone: null,
    channels: [],
    conversationCount: 0,
    leadCount: 0,
    lastConversationId: null,
    lastActivityAt: null,
    marketingOptOut: false,
    createdAt: '2026-01-01T00:00:00Z',
    lastMerge: null,
    contacts: [],
    conversations: [],
    leads: [],
    tags: [{ id: 't1', name: 'VIP', color: 'blue' }],
    customFields: [
      { key: 'company', label: 'Company', type: 'TEXT', value: 'Acme' },
      { key: 'vip', label: 'VIP', type: 'BOOLEAN', value: false },
      { key: 'score', label: 'Score', type: 'NUMBER', value: 5 },
      { key: 'since', label: 'Since', type: 'DATE', value: '2026-01-01' },
    ],
  };
}

function renderWith(ui: React.ReactElement): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('PersonTagsSection', () => {
  it('removes a tag for OPERATOR', async () => {
    vi.mocked(api).mockImplementation((path: string, opts?: { method?: string }) => {
      if (path === '/api/v1/people/p1/tags' && opts?.method === 'PUT')
        return Promise.resolve({ tags: [] });
      return Promise.reject(new Error(path));
    });
    renderWith(<PersonTagsSection person={basePerson()} role={'OPERATOR' as Role} />);
    fireEvent.click(screen.getByTestId('person-tag-remove'));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith('/api/v1/people/p1/tags', {
        method: 'PUT',
        body: { tagIds: [] },
      }),
    );
  });

  it('adds a tag for OPERATOR', async () => {
    vi.mocked(api).mockImplementation((path: string, opts?: { method?: string }) => {
      if (path === '/api/v1/tags')
        return Promise.resolve({
          items: [
            { id: 't1', name: 'VIP', color: 'blue', usage: { people: 1, leads: 0 } },
            { id: 't2', name: 'New', color: null, usage: { people: 0, leads: 0 } },
          ],
        });
      if (path === '/api/v1/people/p1/tags' && opts?.method === 'PUT')
        return Promise.resolve({ tags: [] });
      return Promise.reject(new Error(path));
    });
    renderWith(<PersonTagsSection person={basePerson()} role={'OPERATOR' as Role} />);
    fireEvent.click(screen.getByTestId('person-tag-add'));
    const select = await screen.findByTestId('person-tag-select');
    fireEvent.change(select, { target: { value: 't2' } });
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith('/api/v1/people/p1/tags', {
        method: 'PUT',
        body: { tagIds: ['t1', 't2'] },
      }),
    );
  });

  it('hides edit controls for VIEWER', () => {
    renderWith(<PersonTagsSection person={basePerson()} role={'VIEWER' as Role} />);
    expect(screen.queryByTestId('person-tag-remove')).toBeNull();
    expect(screen.queryByTestId('person-tag-add')).toBeNull();
  });

  it('shows API error via errorKey', async () => {
    vi.mocked(api).mockImplementation((path: string, opts?: { method?: string }) => {
      if (path === '/api/v1/people/p1/tags' && opts?.method === 'PUT')
        return Promise.reject({ code: 'UNKNOWN_TAG' });
      return Promise.reject(new Error(path));
    });
    renderWith(<PersonTagsSection person={basePerson()} role={'ADMIN' as Role} />);
    fireEvent.click(screen.getByTestId('person-tag-remove'));
    expect(await screen.findByText('errors.UNKNOWN_TAG')).toBeInTheDocument();
  });
});

describe('PersonCustomFieldsSection', () => {
  it('saves edited text field', async () => {
    vi.mocked(api).mockResolvedValue({});
    renderWith(<PersonCustomFieldsSection person={basePerson()} role={'OPERATOR' as Role} />);
    const row = screen.getAllByTestId('person-custom-field')[0];
    const input = row.querySelector('input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'NewCo' } });
    fireEvent.click(row.querySelector('[data-testid="person-field-save"]') as HTMLElement);
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith('/api/v1/people/p1/custom-fields', {
        method: 'PATCH',
        body: { values: { company: 'NewCo' } },
      }),
    );
  });

  it('saves boolean and number types', async () => {
    vi.mocked(api).mockResolvedValue({});
    renderWith(<PersonCustomFieldsSection person={basePerson()} role={'ADMIN' as Role} />);
    const rows = screen.getAllByTestId('person-custom-field');
    const boolRow = rows[1];
    const check = boolRow.querySelector('input[type="checkbox"]') as HTMLInputElement;
    fireEvent.click(check);
    fireEvent.click(boolRow.querySelector('[data-testid="person-field-save"]') as HTMLElement);
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith('/api/v1/people/p1/custom-fields', {
        method: 'PATCH',
        body: { values: { vip: true } },
      }),
    );
  });
});
