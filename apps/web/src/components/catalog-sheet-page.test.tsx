import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { CatalogSheetPage } from './catalog-sheet-page';

vi.mock('@/lib/api', () => ({
  api: vi.fn(),
  errorKey: (e: unknown) =>
    `errors.${(e as { code?: string })?.code ?? 'UNKNOWN'}`,
}));

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, values?: Record<string, string | number>) =>
      values ? `${key}|${Object.values(values).join(',')}` : key,
    formatDateTime: () => 'date',
  }),
}));

type SheetRole = 'OWNER' | 'ADMIN' | 'OPERATOR' | 'VIEWER';
const role = vi.hoisted(() => ({ role: 'OWNER' as SheetRole }));
vi.mock('./app-shell', () => ({
  useShell: () => ({
    operator: { id: 'op1', role: role.role },
    timeZone: 'UTC',
  }),
}));

vi.mock('./ui/toast', () => ({ useToast: () => vi.fn() }));
vi.mock('./ui/skeleton', () => ({ SkeletonRows: () => null }));

const CSV =
  'Tour,Price,Departure\nCity tour,100,2026-03-14\nMountain tour,200,2026-03-15\n';

function fakeFile(name: string, text: string, size = text.length) {
  return {
    name,
    size,
    type: 'text/csv',
    text: () => Promise.resolve(text),
  } as unknown as File;
}

function chooseFile(
  input: HTMLElement,
  file: { name: string; size: number; text: () => Promise<string> },
) {
  Object.defineProperty(input, 'files', {
    value: [file],
    configurable: true,
    writable: true,
  });
  fireEvent.change(input);
}

const statusNone = { uploaded: false };
const statusFresh = {
  uploaded: true,
  name: 'prices.csv',
  uploadedAt: '2026-03-10T00:00:00Z',
  freshnessDays: 3,
  validUntil: '2026-03-13',
  stale: false,
  rowCount: 2,
  acceptedCount: 2,
  rejectedCount: 0,
};
const statusStale = { ...statusFresh, stale: true, freshnessDays: 3 };

const previewOk = {
  delimiter: ',',
  header: ['Tour', 'Price', 'Departure'],
  suggestedMapping: { title: 0, price: 1, departureDate: 2 },
  mapping: { title: 0, price: 1, departureDate: 2 },
  missingFields: [],
  rowCount: 2,
  accepted: 2,
  rejected: 0,
  errors: [],
  errorsTruncated: false,
  sample: [
    {
      line: 2,
      title: 'City tour',
      price: '100',
      currency: 'USD',
      departureDate: '2026-03-14',
      availability: 'AVAILABLE',
      seatsLeft: 5,
    },
    {
      line: 3,
      title: 'Mountain tour',
      price: '200',
      currency: 'USD',
      departureDate: '2026-03-15',
      availability: 'LIMITED',
      seatsLeft: 2,
    },
  ],
};

const uploadOk = {
  uploadedAt: '2026-03-14T00:00:00Z',
  accepted: 2,
  rejected: 0,
  catalogBound: true,
  boundTo: null,
};

function configOf(path: string): Record<string, unknown> {
  const q = new URL(path, 'http://x').searchParams.get('config');
  return q
    ? (JSON.parse(decodeURIComponent(q)) as Record<string, unknown>)
    : {};
}

function renderSheet(
  roleName: 'OWNER' | 'ADMIN' | 'OPERATOR' | 'VIEWER' = 'OWNER',
) {
  role.role = roleName;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <CatalogSheetPage />
    </QueryClientProvider>,
  );
}

function mockApi(routes: (path: string, opts: unknown) => Promise<unknown>) {
  vi.mocked(api).mockReset();
  vi.mocked(api).mockImplementation(
    routes as unknown as (path: string, options?: unknown) => Promise<unknown>,
  );
}

beforeEach(() => {
  mockApi((path, opts) => {
    const options = opts as { method?: string; rawBody?: string } | undefined;
    if (
      path === '/api/v1/catalog/sheet' &&
      (options?.method ?? 'GET') === 'GET'
    )
      return Promise.resolve(statusNone);
    if (
      path.startsWith('/api/v1/catalog/sheet/preview') &&
      options?.method === 'POST'
    )
      return Promise.resolve(previewOk);
    if (path.startsWith('/api/v1/catalog/sheet') && options?.method === 'POST')
      return Promise.resolve(uploadOk);
    return Promise.resolve({});
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('CatalogSheetPage role gating', () => {
  it('as owner with no price list: status says none, no save button until a file is chosen', async () => {
    renderSheet('OWNER');
    await waitFor(() => screen.getByText('sheet.status.none'));
    expect(screen.queryByTestId('sheet-save')).toBeNull();
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith('/api/v1/catalog/sheet'),
    );
  });

  it('as admin with no price list: status says none, no save button', async () => {
    renderSheet('ADMIN');
    await waitFor(() => screen.getByText('sheet.status.none'));
    expect(screen.queryByTestId('sheet-save')).toBeNull();
  });

  it('as operator: read-only notice, no request to /api/v1/catalog/sheet', async () => {
    renderSheet('OPERATOR');
    expect(screen.getByText('settings.readOnly')).toBeVisible();
    expect(screen.queryByTestId('sheet-status')).toBeNull();
    await waitFor(() =>
      expect(api).not.toHaveBeenCalledWith(
        expect.stringContaining('/api/v1/catalog/sheet'),
        expect.anything(),
      ),
    );
  });

  it('as viewer: read-only notice, no request to /api/v1/catalog/sheet', async () => {
    renderSheet('VIEWER');
    expect(screen.getByText('settings.readOnly')).toBeVisible();
    expect(screen.queryByTestId('sheet-status')).toBeNull();
    await waitFor(() =>
      expect(api).not.toHaveBeenCalledWith(
        expect.stringContaining('/api/v1/catalog/sheet'),
        expect.anything(),
      ),
    );
  });
});

describe('Choosing a file', () => {
  it('sends exactly one preview request with the file text as body and a config that has freshnessDays but no mapping', async () => {
    renderSheet('OWNER');
    const input = screen.getByTestId('sheet-file');
    chooseFile(input, fakeFile('prices.csv', CSV));
    await waitFor(() => screen.getByTestId('sheet-counts'));
    const previewCalls = vi
      .mocked(api)
      .mock.calls.filter(([path]) =>
        String(path).startsWith('/api/v1/catalog/sheet/preview'),
      );
    expect(previewCalls).toHaveLength(1);
    const [, opts] = previewCalls[0];
    const options = opts as {
      method?: string;
      rawBody?: string;
      contentType?: string;
    };
    expect(options.method).toBe('POST');
    expect(options.rawBody).toBe(CSV);
    expect(options.contentType).toBe('text/csv');
    const config = configOf(previewCalls[0][0]);
    expect(config.freshnessDays).toBe(3);
    expect(config).not.toHaveProperty('mapping');
  });

  it('labels the file input with the chosen name', async () => {
    renderSheet('OWNER');
    screen.getByLabelText(/sheet\.choose/);
    const input = screen.getByTestId('sheet-file');
    chooseFile(input, fakeFile('prices.csv', CSV));
    await waitFor(() => screen.getByTestId('sheet-counts'));
    expect(screen.getByText('sheet.chooseAnother')).toBeVisible();
  });
});

describe('Changing a column mapping', () => {
  it('sends a new preview whose config.mapping holds the chosen index and drops the previous owner of that column', async () => {
    renderSheet('OWNER');
    const input = screen.getByTestId('sheet-file');
    chooseFile(input, fakeFile('prices.csv', CSV));
    await waitFor(() => screen.getByTestId('sheet-counts'));
    // Title currently owns column 0; move title to column 1 (price's column).
    fireEvent.change(screen.getByTestId('sheet-map-title'), {
      target: { value: '1' },
    });
    await waitFor(() => expect(vi.mocked(api).mock.calls).toHaveLength(3));
    const previewCalls = vi
      .mocked(api)
      .mock.calls.filter(([path]) =>
        String(path).startsWith('/api/v1/catalog/sheet/preview'),
      );
    expect(previewCalls).toHaveLength(2);
    const config = configOf(previewCalls[1][0]);
    const mapping = config.mapping as Record<string, unknown>;
    expect(mapping).toEqual({ title: 1, departureDate: 2 });
    // Price lost column 1: it is no longer mapped.
    expect(mapping.price).toBeUndefined();
  });

  it('choosing "Not used" for price shows the missing-fields message and disables save', async () => {
    renderSheet('OWNER');
    const input = screen.getByTestId('sheet-file');
    chooseFile(input, fakeFile('prices.csv', CSV));
    await waitFor(() => screen.getByTestId('sheet-counts'));
    fireEvent.change(screen.getByTestId('sheet-map-price'), {
      target: { value: '' },
    });
    await waitFor(() => screen.getByText('sheet.missing|sheet.field.price'));
    expect(screen.getByTestId('sheet-save')).toBeDisabled();
  });

  it('restoring the price column clears the missing message and enables save', async () => {
    renderSheet('OWNER');
    const input = screen.getByTestId('sheet-file');
    chooseFile(input, fakeFile('prices.csv', CSV));
    await waitFor(() => screen.getByTestId('sheet-counts'));
    fireEvent.change(screen.getByTestId('sheet-map-price'), {
      target: { value: '' },
    });
    await waitFor(() => screen.getByText('sheet.missing|sheet.field.price'));
    expect(screen.getByTestId('sheet-save')).toBeDisabled();
    fireEvent.change(screen.getByTestId('sheet-map-price'), {
      target: { value: '1' },
    });
    await waitFor(() => {
      expect(screen.getByTestId('sheet-counts')).toBeVisible();
      expect(screen.queryByText('sheet.missing|sheet.field.price')).toBeNull();
      expect(screen.getByTestId('sheet-save')).not.toBeDisabled();
    });
  });
});

describe('Preview rendering', () => {
  it('shows the counts, one row per sample line and no skipped section when there are no errors', async () => {
    renderSheet('OWNER');
    const input = screen.getByTestId('sheet-file');
    chooseFile(input, fakeFile('prices.csv', CSV));
    await waitFor(() => screen.getByTestId('sheet-counts'));
    expect(screen.getByText('sheet.preview.counts|2,0')).toBeVisible();
    expect(screen.getAllByTestId('sheet-sample-row')).toHaveLength(2);
    expect(screen.getByText('City tour')).toBeVisible();
    expect(screen.getByText('Mountain tour')).toBeVisible();
    expect(screen.queryByTestId('sheet-skipped-row')).toBeNull();
  });

  it('renders one skipped row per error with line and reason key, and the more-rows note only when truncated', async () => {
    const truncated = {
      ...previewOk,
      errors: [{ line: 3, code: 'PRICE_INVALID', message: 'x' }],
      errorsTruncated: true,
    };
    mockApi((path, opts) => {
      const options = opts as { method?: string; rawBody?: string } | undefined;
      if (
        path === '/api/v1/catalog/sheet' &&
        (options?.method ?? 'GET') === 'GET'
      )
        return Promise.resolve(statusNone);
      if (
        path.startsWith('/api/v1/catalog/sheet/preview') &&
        options?.method === 'POST'
      )
        return Promise.resolve(truncated);
      return Promise.resolve({});
    });
    renderSheet('OWNER');
    const input = screen.getByTestId('sheet-file');
    chooseFile(input, fakeFile('prices.csv', CSV));
    await waitFor(() => screen.getByTestId('sheet-skipped-row'));
    expect(
      screen.getByText('sheet.skipped.row|3,sheet.rowError.PRICE_INVALID'),
    ).toBeVisible();
    expect(screen.getByText('sheet.skipped.more')).toBeVisible();
    expect(screen.getAllByTestId('sheet-skipped-row')).toHaveLength(1);
  });

  it('omits the more-rows note when errorsTruncated is false', async () => {
    renderSheet('OWNER');
    const input = screen.getByTestId('sheet-file');
    chooseFile(input, fakeFile('prices.csv', CSV));
    await waitFor(() => screen.getByTestId('sheet-counts'));
    expect(screen.queryByText('sheet.skipped.more')).toBeNull();
  });
});

describe('Save', () => {
  it('POSTs filename, the same config and the file text, then clears the file and shows the bound key', async () => {
    const uploaded = { ...statusFresh };
    mockApi((path, opts) => {
      const options = opts as { method?: string; rawBody?: string } | undefined;
      if (
        path === '/api/v1/catalog/sheet' &&
        (options?.method ?? 'GET') === 'GET'
      )
        return Promise.resolve(uploaded);
      if (
        path.startsWith('/api/v1/catalog/sheet/preview') &&
        options?.method === 'POST'
      )
        return Promise.resolve(previewOk);
      if (
        path.startsWith('/api/v1/catalog/sheet') &&
        options?.method === 'POST'
      )
        return Promise.resolve(uploadOk);
      return Promise.resolve({});
    });
    renderSheet('OWNER');
    const input = screen.getByTestId('sheet-file');
    chooseFile(input, fakeFile('prices.csv', CSV));
    await waitFor(() => screen.getByTestId('sheet-counts'));
    expect(screen.getByTestId('sheet-save')).not.toBeDisabled();
    fireEvent.click(screen.getByTestId('sheet-save'));
    await waitFor(() => screen.getByText('sheet.bound'));
    const uploadCalls = vi.mocked(api).mock.calls.filter(([path, opts]) => {
      const o = opts as { method?: string } | undefined;
      return (
        String(path).startsWith('/api/v1/catalog/sheet') &&
        !String(path).includes('/preview') &&
        o?.method === 'POST'
      );
    });
    expect(uploadCalls).toHaveLength(1);
    const [upPath, upOpts] = uploadCalls[0];
    const upOptions = upOpts as { method?: string; rawBody?: string };
    expect(upOptions.method).toBe('POST');
    expect(upOptions.rawBody).toBe(CSV);
    expect(String(upPath)).toContain('filename=prices.csv');
    const upConfig = configOf(upPath);
    expect(upConfig.freshnessDays).toBe(3);
    expect(upConfig).not.toHaveProperty('mapping');
    // File cleared and preview gone.
    expect(screen.getByLabelText(/sheet\.choose/)).toBeTruthy();
    expect(screen.queryByTestId('sheet-counts')).toBeNull();
    // Status query refetched after save.
    await waitFor(() => {
      const statusCalls = vi
        .mocked(api)
        .mock.calls.filter(([p]) => String(p) === '/api/v1/catalog/sheet');
      expect(statusCalls).toHaveLength(2);
    });
  });

  it('shows boundOther with the name when the catalog is bound elsewhere', async () => {
    const boundOther = {
      ...uploadOk,
      catalogBound: false,
      boundTo: 'Winter catalog',
    };
    const uploaded = { ...statusFresh };
    mockApi((path, opts) => {
      const options = opts as { method?: string; rawBody?: string } | undefined;
      if (
        path === '/api/v1/catalog/sheet' &&
        (options?.method ?? 'GET') === 'GET'
      )
        return Promise.resolve(uploaded);
      if (
        path.startsWith('/api/v1/catalog/sheet/preview') &&
        options?.method === 'POST'
      )
        return Promise.resolve(previewOk);
      if (
        path.startsWith('/api/v1/catalog/sheet') &&
        options?.method === 'POST'
      )
        return Promise.resolve(boundOther);
      return Promise.resolve({});
    });
    renderSheet('OWNER');
    const input = screen.getByTestId('sheet-file');
    chooseFile(input, fakeFile('prices.csv', CSV));
    await waitFor(() => screen.getByTestId('sheet-counts'));
    fireEvent.click(screen.getByTestId('sheet-save'));
    await waitFor(() => screen.getByText('sheet.boundOther|Winter catalog'));
    expect(screen.getByText('sheet.boundOther|Winter catalog')).toBeVisible();
    expect(screen.queryByText('sheet.bound')).toBeNull();
  });
});

describe('Failures', () => {
  it('a preview 400 (SHEET_EMPTY) shows the error key in sheet-error and no save button', async () => {
    mockApi((path, opts) => {
      const options = opts as { method?: string; rawBody?: string } | undefined;
      if (
        path === '/api/v1/catalog/sheet' &&
        (options?.method ?? 'GET') === 'GET'
      )
        return Promise.resolve(statusNone);
      if (
        path.startsWith('/api/v1/catalog/sheet/preview') &&
        options?.method === 'POST'
      )
        return Promise.reject({
          status: 400,
          code: 'SHEET_EMPTY',
          i18nKey: 'errors.SHEET_EMPTY',
        });
      return Promise.resolve({});
    });
    renderSheet('OWNER');
    const input = screen.getByTestId('sheet-file');
    chooseFile(input, fakeFile('prices.csv', CSV));
    await waitFor(() => screen.getByText('errors.SHEET_EMPTY'));
    expect(screen.getByTestId('sheet-error')).toHaveTextContent(
      'errors.SHEET_EMPTY',
    );
    expect(screen.queryByTestId('sheet-save')).toBeNull();
  });

  it('an upload 400 (SHEET_NO_VALID_ROWS) shows its key in sheet-save-error and keeps the preview', async () => {
    mockApi((path, opts) => {
      const options = opts as { method?: string; rawBody?: string } | undefined;
      if (
        path === '/api/v1/catalog/sheet' &&
        (options?.method ?? 'GET') === 'GET'
      )
        return Promise.resolve(statusNone);
      if (
        path.startsWith('/api/v1/catalog/sheet/preview') &&
        options?.method === 'POST'
      )
        return Promise.resolve(previewOk);
      if (
        path.startsWith('/api/v1/catalog/sheet') &&
        options?.method === 'POST'
      )
        return Promise.reject({
          status: 400,
          code: 'SHEET_NO_VALID_ROWS',
          i18nKey: 'errors.SHEET_NO_VALID_ROWS',
        });
      return Promise.resolve({});
    });
    renderSheet('OWNER');
    const input = screen.getByTestId('sheet-file');
    chooseFile(input, fakeFile('prices.csv', CSV));
    await waitFor(() => screen.getByTestId('sheet-counts'));
    fireEvent.click(screen.getByTestId('sheet-save'));
    await waitFor(() => screen.getByText('errors.SHEET_NO_VALID_ROWS'));
    expect(screen.getByTestId('sheet-save-error')).toHaveTextContent(
      'errors.SHEET_NO_VALID_ROWS',
    );
    // Preview is still there.
    expect(screen.getByTestId('sheet-counts')).toBeVisible();
  });

  it('a file over 5 MB is refused in the browser with SHEET_TOO_LARGE and sends no preview request', async () => {
    mockApi((path, opts) => {
      const options = opts as { method?: string; rawBody?: string } | undefined;
      if (
        path === '/api/v1/catalog/sheet' &&
        (options?.method ?? 'GET') === 'GET'
      )
        return Promise.resolve(statusNone);
      return Promise.resolve({});
    });
    renderSheet('OWNER');
    const input = screen.getByTestId('sheet-file');
    chooseFile(input, fakeFile('big.csv', '', 6 * 1024 * 1024));
    await waitFor(() => screen.getByText('errors.SHEET_TOO_LARGE'));
    const previewCalls = vi
      .mocked(api)
      .mock.calls.filter(([path]) =>
        String(path).startsWith('/api/v1/catalog/sheet/preview'),
      );
    expect(previewCalls).toHaveLength(0);
    expect(screen.queryByTestId('sheet-save')).toBeNull();
  });
});

describe('Stale status', () => {
  it('stale: true shows the stale badge and stale body with the days', async () => {
    mockApi((path, opts) => {
      const options = opts as { method?: string } | undefined;
      if (
        path === '/api/v1/catalog/sheet' &&
        (options?.method ?? 'GET') === 'GET'
      )
        return Promise.resolve(statusStale);
      return Promise.resolve({});
    });
    renderSheet('OWNER');
    await waitFor(() => screen.getByText('sheet.stale.badge'));
    expect(screen.getByText('sheet.stale.body|3')).toBeVisible();
    expect(screen.queryByText('sheet.fresh.badge')).toBeNull();
  });

  it('stale: false shows the fresh badge and the valid-until date', async () => {
    mockApi((path, opts) => {
      const options = opts as { method?: string } | undefined;
      if (
        path === '/api/v1/catalog/sheet' &&
        (options?.method ?? 'GET') === 'GET'
      )
        return Promise.resolve(statusFresh);
      return Promise.resolve({});
    });
    renderSheet('OWNER');
    await waitFor(() => screen.getByText('sheet.fresh.badge'));
    expect(screen.getByText(/sheet\.fresh\.body\|/)).toBeVisible();
    expect(screen.queryByText('sheet.stale.badge')).toBeNull();
  });
});
