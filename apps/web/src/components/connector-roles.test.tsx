import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '@/lib/api';
import type { ConnectorSummary } from '@/lib/types';
import type { ConnectorRoleItem } from './connector-roles';
import { ConnectorRoles } from './connector-roles';

const toastMock = vi.fn();
let currentRole = 'OWNER';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, _values?: Record<string, unknown>) => {
      if (key.startsWith('connectorRoles.role.')) return key;
      if (key.startsWith('connectorRoles.desc.')) return key;
      if (key.startsWith('connectorRoles.status.')) return key;
      if (key === 'connectorRoles.title') return 'Connector roles';
      if (key === 'connectorRoles.notChosen') return 'Not chosen';
      if (key === 'connectorRoles.activeConnectors') return 'Active connectors';
      if (key === 'connectorRoles.save') return 'Role saved.';
      if (key.startsWith('errors.')) return key;
      if (key === 'app.loading') return 'Loading...';
      if (key === 'app.retry') return 'Retry';
      return key;
    },
    formatDateTime: () => 'date',
  }),
}));

vi.mock('./app-shell', () => ({
  useShell: () => ({
    operator: { id: 'op1', displayName: 'Op', role: currentRole },
    timeZone: 'UTC',
  }),
}));

vi.mock('./ui/toast', () => ({
  useToast: () => toastMock,
}));

vi.mock('@/lib/api', () => {
  class MockApiError extends Error {
    constructor(
      readonly status: number,
      readonly code: string,
      readonly i18nKey?: string,
    ) {
      super(code);
    }
  }
  return {
    api: vi.fn(),
    ApiError: MockApiError,
    errorKey: (e: unknown) => {
      if (e instanceof MockApiError) {
        if (e.i18nKey) return e.i18nKey;
        return `errors.${e.code}`;
      }
      return 'errors.UNKNOWN';
    },
  };
});

const connectors: ConnectorSummary[] = [
  {
    id: 'conn-1',
    connectorKey: 'bitrix24',
    status: 'ACTIVE',
    configured: true,
  },
  {
    id: 'conn-2',
    connectorKey: 'mock',
    status: 'ACTIVE',
    configured: true,
  },
  {
    id: 'conn-3',
    connectorKey: 'disabled',
    status: 'DISABLED',
    configured: true,
  },
];

const rolesResponse: { items: ConnectorRoleItem[] } = {
  items: [
    {
      role: 'CATALOG',
      tenantConnectorId: null,
      connectorKey: null,
      status: 'UNBOUND',
    },
    {
      role: 'LEAD_SINK',
      tenantConnectorId: 'conn-1',
      connectorKey: 'bitrix24',
      status: 'BOUND',
    },
    {
      role: 'ACTIONS',
      tenantConnectorId: null,
      connectorKey: null,
      status: 'AMBIGUOUS',
    },
  ],
};

function renderRoles(connectorsList: ConnectorSummary[] = connectors): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ConnectorRoles connectors={connectorsList} />
    </QueryClientProvider>,
  );
  return;
}

function mockRolesApi(
  opts: {
    getRoles?: ConnectorRoleItem[] | 'error';
    putResult?: ConnectorRoleItem | Error;
  } = {},
): void {
  vi.mocked(api).mockImplementation(
    (path: string, options?: { method?: string; body?: unknown }) => {
      if (path === '/api/v1/connectors/roles' && !options?.method) {
        if (opts.getRoles === 'error')
          return Promise.reject(new Error('roles-fail'));
        return Promise.resolve({ items: opts.getRoles ?? rolesResponse.items });
      }
      if (path === '/api/v1/connectors/roles' && options?.method === 'PUT') {
        if (opts.putResult instanceof Error)
          return Promise.reject(opts.putResult);
        const body = options.body as {
          role: string;
          tenantConnectorId: string | null;
        };
        return Promise.resolve({
          ...(opts.putResult ??
            rolesResponse.items.find((i) => i.role === body.role)),
          role: body.role,
          tenantConnectorId: body.tenantConnectorId,
        });
      }
      return Promise.reject(new Error(`unexpected ${path}`));
    },
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  currentRole = 'OWNER';
});

describe('ConnectorRoles', () => {
  it('renders all three roles with names, descriptions and status badges', async () => {
    mockRolesApi();
    renderRoles();

    await screen.findByTestId('connector-role-CATALOG');
    await screen.findByTestId('connector-role-LEAD_SINK');
    await screen.findByTestId('connector-role-ACTIONS');
    expect(
      screen.getByTestId('connector-role-badge-LEAD_SINK'),
    ).toHaveTextContent('connectorRoles.status.BOUND');
    expect(
      screen.getByTestId('connector-role-badge-CATALOG'),
    ).toHaveTextContent('connectorRoles.status.UNBOUND');
    expect(
      screen.getByTestId('connector-role-badge-ACTIONS'),
    ).toHaveTextContent('connectorRoles.status.AMBIGUOUS');
  });

  it('keeps the selects visible: they are not inside a screen-reader-only wrapper', async () => {
    mockRolesApi();
    renderRoles();
    for (const role of ['CATALOG', 'LEAD_SINK', 'ACTIONS']) {
      const select = await screen.findByTestId(`connector-role-select-${role}`);
      expect(select.closest('.sr-only')).toBeNull();
      expect(select).toHaveAttribute('aria-label');
    }
  });

  it('shows only ACTIVE connectors in the select', async () => {
    mockRolesApi();
    renderRoles();

    await screen.findByTestId('connector-role-select-CATALOG');
    const select = screen.getByTestId('connector-role-select-CATALOG');
    expect(within(select).getByText('bitrix24')).toBeInTheDocument();
    expect(within(select).getByText('mock')).toBeInTheDocument();
    expect(screen.queryByText('disabled')).not.toBeInTheDocument();
  });

  it('shows Not chosen when unbound', async () => {
    mockRolesApi();
    renderRoles();

    await screen.findByTestId('connector-role-select-CATALOG');
    const select = screen.getByTestId('connector-role-select-CATALOG');
    expect(select).toHaveValue('');
  });

  it('binds with exact PUT body and shows toast', async () => {
    mockRolesApi();
    renderRoles();

    await screen.findByTestId('connector-role-select-CATALOG');
    const select = screen.getByTestId('connector-role-select-CATALOG');
    fireEvent.change(select, { target: { value: 'conn-2' } });

    await waitFor(() => {
      expect(api).toHaveBeenCalledWith('/api/v1/connectors/roles', {
        method: 'PUT',
        body: { role: 'CATALOG', tenantConnectorId: 'conn-2' },
      });
    });
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith('Role saved.'));
  });

  it('unbinds by sending null tenantConnectorId', async () => {
    mockRolesApi();
    const boundRoles = {
      items: [
        {
          role: 'LEAD_SINK',
          tenantConnectorId: 'conn-1',
          connectorKey: 'bitrix24',
          status: 'BOUND',
        },
      ],
    };
    vi.mocked(api).mockImplementation(
      (path: string, options?: { method?: string; body?: unknown }) => {
        if (path === '/api/v1/connectors/roles' && !options?.method)
          return Promise.resolve(boundRoles);
        if (path === '/api/v1/connectors/roles' && options?.method === 'PUT') {
          const body = options.body as {
            role: string;
            tenantConnectorId: string | null;
          };
          return Promise.resolve({ ...body, role: body.role });
        }
        return Promise.reject(new Error(`unexpected ${path}`));
      },
    );
    renderRoles();

    await screen.findByTestId('connector-role-select-LEAD_SINK');
    const select = screen.getByTestId('connector-role-select-LEAD_SINK');
    fireEvent.change(select, { target: { value: '' } });

    await waitFor(() => {
      expect(api).toHaveBeenCalledWith('/api/v1/connectors/roles', {
        method: 'PUT',
        body: { role: 'LEAD_SINK', tenantConnectorId: null },
      });
    });
  });

  it('maps CONNECTOR_CAPABILITY_MISSING error to inline text', async () => {
    mockRolesApi({
      putResult: new ApiError(400, 'CONNECTOR_CAPABILITY_MISSING'),
    });
    renderRoles();

    await screen.findByTestId('connector-role-select-CATALOG');
    const select = screen.getByTestId('connector-role-select-CATALOG');
    fireEvent.change(select, { target: { value: 'conn-2' } });

    await waitFor(() => {
      expect(
        screen.getByTestId('connector-role-error-CATALOG'),
      ).toHaveTextContent('errors.CONNECTOR_CAPABILITY_MISSING');
    });
  });

  it('hides section for OPERATOR and VIEWER and makes no request', async () => {
    currentRole = 'OPERATOR';
    mockRolesApi();
    renderRoles();
    expect(screen.queryByTestId('connector-roles-section')).toBeNull();
    expect(api).not.toHaveBeenCalledWith(
      '/api/v1/connectors/roles',
      expect.objectContaining({ method: undefined }),
    );

    cleanup();
    currentRole = 'VIEWER';
    mockRolesApi();
    renderRoles();
    expect(screen.queryByTestId('connector-roles-section')).toBeNull();
  });

  it('disables select while saving', async () => {
    let resolvePut: (value: unknown) => void = () => {};
    vi.mocked(api).mockImplementation(
      (path: string, options?: { method?: string; body?: unknown }) => {
        if (path === '/api/v1/connectors/roles' && !options?.method)
          return Promise.resolve(rolesResponse);
        if (path === '/api/v1/connectors/roles' && options?.method === 'PUT') {
          return new Promise((resolve) => {
            resolvePut = (value: unknown) => resolve(value);
          });
        }
        return Promise.reject(new Error(`unexpected ${path}`));
      },
    );
    renderRoles();

    await screen.findByTestId('connector-role-select-CATALOG');
    const select = screen.getByTestId('connector-role-select-CATALOG');
    expect(select).not.toBeDisabled();
    fireEvent.change(select, { target: { value: 'conn-2' } });
    await waitFor(() => expect(select).toBeDisabled());
    resolvePut({
      role: 'CATALOG',
      tenantConnectorId: 'conn-2',
      connectorKey: null,
      status: 'BOUND',
    });
    await waitFor(() => expect(select).not.toBeDisabled());
  });
});
