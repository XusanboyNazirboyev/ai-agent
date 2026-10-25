import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { LeadInput } from '../connectors/contracts/canonical.js';
import type {
  CrmConnector,
  WriteContext,
  WriteIdempotency,
} from '../connectors/interfaces/crm-connector.js';
import {
  ConnectorError,
  ConnectorErrorCategory,
  ConnectorTimeoutError,
  ConnectorUnavailableError,
  ConnectorUnauthorizedError,
} from '../connectors/interfaces/errors.js';
import type { TenantConnectorLoader } from '../connectors/sync/tenant-connector-loader.js';
import { PrismaClient } from '../generated/prisma/client.js';
import { createPostgresAdapter } from '../persistence/postgres-adapter.js';
import type { PrismaService } from '../persistence/prisma.service.js';
import {
  CRM_OUTCOME_UNCERTAIN,
  LEAD_SYNC_LEASE_MS,
  LeadSyncService,
} from './lead-sync.service.js';

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test') {
  throw new Error('Lead sync integration tests require agentcore_test');
}
const db = new PrismaClient({
  adapter: createPostgresAdapter(process.env, 'TEST_'),
});
const prisma = db as unknown as PrismaService;
// A second client = a second worker process with its own connections.
const db2 = new PrismaClient({
  adapter: createPostgresAdapter(process.env, 'TEST_'),
});
afterAll(async () => {
  await db.$disconnect();
  await db2.$disconnect();
});

type Step =
  | 'ok'
  | 'reject' // remote validation error: not applied
  | 'refuse' // connection refused: not applied
  | 'commit-then-timeout' // applied, response lost
  | 'timeout-before-commit' // unclear, not applied
  | { hold: Promise<void> }; // applied after the promise resolves (in-flight)

/** A fictional CRM with fault injection that counts what it really stored. */
class FakeCrm {
  readonly records: { id: string; key?: string }[] = [];
  readonly createCalls: (string | undefined)[] = [];
  lookupCalls = 0;
  lookupFails = false;
  constructor(
    readonly mode: WriteIdempotency,
    private readonly steps: Step[],
  ) {}

  connector(): CrmConnector {
    return {
      connectorKey: 'fake',
      context: { tenantId: 't', connectorKey: 'fake' },
      writeIdempotency: this.mode,
      capabilities: {
        sync: false,
        search: false,
        liveQuote: false,
        availability: false,
        createLead: true,
        updateLead: false,
        createBooking: false,
        webhooks: false,
      },
      createLead: (
        input: LeadInput,
        context?: WriteContext,
      ): Promise<{ crmLeadId: string }> => this.create(input, context),
      ...(this.mode === 'lookup'
        ? {
            findLeadByIdempotencyKey: async (
              key: string,
            ): Promise<{ crmLeadId: string } | undefined> => {
              this.lookupCalls += 1;
              if (this.lookupFails)
                throw new ConnectorUnauthorizedError({
                  message: 'lookup refused',
                });
              const found = this.records.find((r) => r.key === key);
              return found ? { crmLeadId: found.id } : undefined;
            },
          }
        : {}),
    } as CrmConnector;
  }

  private store(key: string | undefined): string {
    if (this.mode !== 'none' && key) {
      const existing = this.records.find((r) => r.key === key);
      if (existing && this.mode === 'native') return existing.id;
    }
    const id = `crm-${this.records.length + 1}`;
    this.records.push({ id, key: this.mode === 'none' ? undefined : key });
    return id;
  }

  private async create(
    _input: LeadInput,
    context?: WriteContext,
  ): Promise<{ crmLeadId: string }> {
    this.createCalls.push(context?.idempotencyKey);
    const step = this.steps.shift() ?? 'ok';
    if (step === 'reject')
      throw new ConnectorError({
        message: 'invalid',
        code: 'CONNECTOR_REQUEST_FAILED',
        category: ConnectorErrorCategory.VALIDATION,
      });
    if (step === 'refuse')
      throw new ConnectorUnavailableError({
        message: 'refused',
        code: 'CONNECTOR_NETWORK_FAILURE',
        executed: 'no',
      });
    if (step === 'commit-then-timeout') {
      this.store(context?.idempotencyKey);
      throw new ConnectorTimeoutError({ message: 'timeout' });
    }
    if (step === 'timeout-before-commit')
      throw new ConnectorTimeoutError({ message: 'timeout' });
    if (typeof step === 'object') {
      await step.hold;
      return { crmLeadId: this.store(context?.idempotencyKey) };
    }
    return { crmLeadId: this.store(context?.idempotencyKey) };
  }
}

const loaderFor = (crm: FakeCrm): TenantConnectorLoader =>
  ({ create: () => crm.connector() }) as unknown as TenantConnectorLoader;

async function leadWorld(): Promise<{ tenantId: string; leadId: string }> {
  const suffix = randomUUID();
  const tenant = await db.tenant.create({
    data: {
      slug: `ls-${suffix}`,
      name: 'Lead sync fixture',
      defaultLocale: 'en',
      supportedLocales: ['en'],
      timezone: 'UTC',
      packKey: 'education',
      packVersion: '1',
    },
  });
  const account = await db.channelAccount.create({
    data: {
      tenantId: tenant.id,
      channelType: 'telegram',
      externalAccountId: `ls-${suffix}`,
      status: 'ACTIVE',
    },
  });
  const contact = await db.contact.create({
    data: {
      tenantId: tenant.id,
      channelAccountId: account.id,
      providerUserId: `u-${suffix}`,
      name: 'Fictional',
    },
  });
  const conversation = await db.conversation.create({
    data: {
      tenantId: tenant.id,
      channelAccountId: account.id,
      contactId: contact.id,
      providerChatId: `c-${suffix}`,
    },
  });
  await db.tenantConnector.create({
    data: {
      tenantId: tenant.id,
      connectorKey: 'mock',
      status: 'ACTIVE',
      config: { sourceSystem: 'x' },
    },
  });
  const lead = await db.lead.create({
    data: {
      tenantId: tenant.id,
      contactId: contact.id,
      conversationId: conversation.id,
      score: 'WARM',
      summary: 'Fictional lead',
      requirements: {},
      idempotencyKey: `lead-${suffix}`,
      crmSyncStatus: 'PENDING',
    },
  });
  return { tenantId: tenant.id, leadId: lead.id };
}

const later = (base: Date, ms: number): Date => new Date(base.getTime() + ms);
const op = (
  tenantId: string,
  leadId: string,
): ReturnType<typeof db.connectorOperation.findFirstOrThrow> =>
  db.connectorOperation.findFirstOrThrow({
    where: { tenantId, subjectId: leadId },
  });
const leadRow = (
  leadId: string,
): ReturnType<typeof db.lead.findUniqueOrThrow> =>
  db.lead.findUniqueOrThrow({ where: { id: leadId } });

describe('lead CRM sync: one logical write per lead', () => {
  it('success: one record, evidence stored, one stable key', async () => {
    const w = await leadWorld();
    const crm = new FakeCrm('none', ['ok']);
    const sync = new LeadSyncService(prisma, loaderFor(crm));
    expect(await sync.sync(w.tenantId, w.leadId)).toBe('SYNCED');
    expect(await sync.sync(w.tenantId, w.leadId)).toBe('SKIPPED');
    expect(crm.records).toHaveLength(1);
    expect(crm.createCalls).toEqual([`createLead:lead:${w.leadId}`]);
    expect(await leadRow(w.leadId)).toMatchObject({
      crmSyncStatus: 'SYNCED',
      crmLeadId: 'crm-1',
      attempts: 1,
    });
    expect(await op(w.tenantId, w.leadId)).toMatchObject({
      status: 'SUCCEEDED',
      externalId: 'crm-1',
      attempts: 1,
      leaseToken: null,
    });
  });

  it('a definitive failure before execution is retried later with the same key', async () => {
    for (const first of ['reject', 'refuse'] as const) {
      const w = await leadWorld();
      const crm = new FakeCrm('none', [first, 'ok']);
      const sync = new LeadSyncService(prisma, loaderFor(crm));
      const t0 = new Date();
      expect(await sync.sync(w.tenantId, w.leadId, t0)).toBe('FAILED');
      const failed = await op(w.tenantId, w.leadId);
      expect(failed).toMatchObject({
        status: 'RETRY_WAIT',
        lastExecution: 'NOT_EXECUTED',
      });
      // Not due yet: a redelivered job does not hammer the CRM.
      expect(await sync.sync(w.tenantId, w.leadId, t0)).toBe('SKIPPED');
      expect(
        await sync.sync(w.tenantId, w.leadId, later(failed.nextAttemptAt!, 1)),
      ).toBe('SYNCED');
      expect(crm.records).toHaveLength(1);
      expect(new Set(crm.createCalls)).toEqual(
        new Set([`createLead:lead:${w.leadId}`]),
      );
      expect(crm.createCalls).toHaveLength(2);
    }
  });

  it('native: CRM committed but the response was lost -> retry with the same key, no second record', async () => {
    const w = await leadWorld();
    const crm = new FakeCrm('native', ['commit-then-timeout', 'ok']);
    const sync = new LeadSyncService(prisma, loaderFor(crm));
    const t0 = new Date();
    expect(await sync.sync(w.tenantId, w.leadId, t0)).toBe('FAILED');
    const waiting = await op(w.tenantId, w.leadId);
    expect(waiting).toMatchObject({
      status: 'RETRY_WAIT',
      lastExecution: 'UNCERTAIN',
      attemptMode: 'native',
    });
    expect(
      await sync.sync(w.tenantId, w.leadId, later(waiting.nextAttemptAt!, 1)),
    ).toBe('SYNCED');
    expect(crm.records).toHaveLength(1);
    expect(crm.createCalls).toEqual([
      `createLead:lead:${w.leadId}`,
      `createLead:lead:${w.leadId}`,
    ]);
    expect(await leadRow(w.leadId)).toMatchObject({
      crmSyncStatus: 'SYNCED',
      crmLeadId: 'crm-1',
    });
  });

  it('lookup: after a lost response the record is found, not created again', async () => {
    const w = await leadWorld();
    const crm = new FakeCrm('lookup', ['commit-then-timeout']);
    const sync = new LeadSyncService(prisma, loaderFor(crm));
    const t0 = new Date();
    expect(await sync.sync(w.tenantId, w.leadId, t0)).toBe('FAILED');
    const waiting = await op(w.tenantId, w.leadId);
    expect(
      await sync.sync(w.tenantId, w.leadId, later(waiting.nextAttemptAt!, 1)),
    ).toBe('SYNCED');
    expect(crm.createCalls).toHaveLength(1);
    expect(crm.lookupCalls).toBe(1);
    expect(crm.records).toHaveLength(1);
    expect(await leadRow(w.leadId)).toMatchObject({
      crmSyncStatus: 'SYNCED',
      crmLeadId: 'crm-1',
    });
  });

  it('lookup: nothing was created -> create once; a failed lookup keeps the doubt', async () => {
    const w = await leadWorld();
    const crm = new FakeCrm('lookup', ['timeout-before-commit', 'ok']);
    const sync = new LeadSyncService(prisma, loaderFor(crm));
    expect(await sync.sync(w.tenantId, w.leadId, new Date())).toBe('FAILED');
    // The lookup itself fails (even with an error that proves nothing was sent):
    // the earlier attempt is still unclear, so the next try must look up again.
    crm.lookupFails = true;
    let row = await op(w.tenantId, w.leadId);
    expect(
      await sync.sync(w.tenantId, w.leadId, later(row.nextAttemptAt!, 1)),
    ).toBe('FAILED');
    row = await op(w.tenantId, w.leadId);
    expect(row).toMatchObject({
      status: 'RETRY_WAIT',
      lastExecution: 'UNCERTAIN',
    });
    expect(crm.createCalls).toHaveLength(1);
    crm.lookupFails = false;
    expect(
      await sync.sync(w.tenantId, w.leadId, later(row.nextAttemptAt!, 1)),
    ).toBe('SYNCED');
    expect(crm.lookupCalls).toBe(2);
    expect(crm.createCalls).toHaveLength(2);
    expect(crm.records).toHaveLength(1);
  });

  it('none: an unclear outcome is never retried automatically and waits for a person', async () => {
    const w = await leadWorld();
    const crm = new FakeCrm('none', ['commit-then-timeout']);
    const sync = new LeadSyncService(prisma, loaderFor(crm));
    expect(await sync.sync(w.tenantId, w.leadId)).toBe('UNCERTAIN');
    expect(await op(w.tenantId, w.leadId)).toMatchObject({
      status: 'UNCERTAIN',
      lastExecution: 'UNCERTAIN',
      leaseToken: null,
    });
    expect(await leadRow(w.leadId)).toMatchObject({
      crmSyncStatus: 'FAILED',
      lastErrorCode: CRM_OUTCOME_UNCERTAIN,
      nextAttemptAt: null,
    });
    // Neither the scan nor a new job (e.g. after a re-score) calls the CRM again.
    // (scanDue spans all tenants of the shared test database: assert this lead only.)
    await sync.scanDue(later(new Date(), 30 * 24 * 3_600_000));
    expect(
      await db.outboxEvent.count({
        where: {
          tenantId: w.tenantId,
          type: 'crm.lead.sync',
          aggregateId: w.leadId,
        },
      }),
    ).toBe(0);
    expect(
      await sync.sync(w.tenantId, w.leadId, later(new Date(), 3_600_000)),
    ).toBe('UNCERTAIN');
    expect(crm.createCalls).toHaveLength(1);
    expect(crm.records).toHaveLength(1); // the CRM did keep it: exactly why we must not retry
  });

  it('a person resolves an uncertain write, tenant-scoped and audited', async () => {
    const w = await leadWorld();
    const other = await leadWorld();
    const crm = new FakeCrm('none', ['commit-then-timeout']);
    const sync = new LeadSyncService(prisma, loaderFor(crm));
    expect(await sync.sync(w.tenantId, w.leadId)).toBe('UNCERTAIN');
    expect(
      await sync.resolveUncertain({
        tenantId: other.tenantId,
        leadId: w.leadId,
        outcome: 'SUCCEEDED',
        crmLeadId: 'crm-1',
        actor: 'ops',
      }),
    ).toBe('NOT_UNCERTAIN');
    expect(
      await sync.resolveUncertain({
        tenantId: w.tenantId,
        leadId: w.leadId,
        outcome: 'SUCCEEDED',
        actor: 'ops',
      }),
    ).toBe('MISSING_EVIDENCE');
    expect(
      await sync.resolveUncertain({
        tenantId: w.tenantId,
        leadId: w.leadId,
        outcome: 'SUCCEEDED',
        crmLeadId: 'crm-1',
        actor: 'ops',
      }),
    ).toBe('RESOLVED');
    expect(
      await sync.resolveUncertain({
        tenantId: w.tenantId,
        leadId: w.leadId,
        outcome: 'FAILED',
        actor: 'ops',
      }),
    ).toBe('NOT_UNCERTAIN');
    expect(await leadRow(w.leadId)).toMatchObject({
      crmSyncStatus: 'SYNCED',
      crmLeadId: 'crm-1',
    });
    expect(await op(w.tenantId, w.leadId)).toMatchObject({
      status: 'RESOLVED_SUCCEEDED',
      externalId: 'crm-1',
      resolvedBy: 'ops',
    });
    expect(
      await db.auditEvent.count({
        where: { tenantId: w.tenantId, action: 'crm.operation.resolved' },
      }),
    ).toBe(1);
    expect(await sync.sync(w.tenantId, w.leadId)).toBe('SKIPPED');
    expect(crm.createCalls).toHaveLength(1);
  });

  it('two workers delivering the same job concurrently: one CRM call', async () => {
    const w = await leadWorld();
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const crm = new FakeCrm('none', [{ hold }]);
    const one = new LeadSyncService(prisma, loaderFor(crm));
    const two = new LeadSyncService(
      db2 as unknown as PrismaService,
      loaderFor(crm),
    );
    const first = one.sync(w.tenantId, w.leadId);
    await new Promise((r) => setTimeout(r, 100));
    const results = await Promise.all([
      two.sync(w.tenantId, w.leadId),
      two.sync(w.tenantId, w.leadId),
    ]);
    expect(results).toEqual(['SKIPPED', 'SKIPPED']);
    release();
    expect(await first).toBe('SYNCED');
    expect(crm.createCalls).toHaveLength(1);
    expect(crm.records).toHaveLength(1);
  });

  it('a worker that dies mid-call: native retries with the same key, none stops as uncertain', async () => {
    for (const mode of ['native', 'none'] as const) {
      const w = await leadWorld();
      const hold = new Promise<void>(() => undefined); // never returns: the worker is gone
      const crm = new FakeCrm(mode, [{ hold }, 'ok']);
      const dead = new LeadSyncService(prisma, loaderFor(crm));
      void dead.sync(w.tenantId, w.leadId);
      await new Promise((r) => setTimeout(r, 100));
      expect(await op(w.tenantId, w.leadId)).toMatchObject({
        status: 'IN_FLIGHT',
      });
      // Before the lease expires nothing is re-queued or attempted.
      const recovery = new LeadSyncService(
        db2 as unknown as PrismaService,
        loaderFor(crm),
      );
      expect(await recovery.sync(w.tenantId, w.leadId)).toBe('SKIPPED');
      const afterLease = later(new Date(), LEAD_SYNC_LEASE_MS + 1_000);
      expect(await recovery.scanDue(afterLease)).toBeGreaterThanOrEqual(1);
      const outbox = await db.outboxEvent.count({
        where: {
          tenantId: w.tenantId,
          type: 'crm.lead.sync',
          aggregateId: w.leadId,
        },
      });
      expect(outbox).toBe(1);
      const result = await recovery.sync(w.tenantId, w.leadId, afterLease);
      if (mode === 'native') {
        expect(result).toBe('SYNCED');
        expect(crm.createCalls).toEqual([
          `createLead:lead:${w.leadId}`,
          `createLead:lead:${w.leadId}`,
        ]);
      } else {
        expect(result).toBe('UNCERTAIN');
        expect(crm.createCalls).toHaveLength(1);
        expect(await op(w.tenantId, w.leadId)).toMatchObject({
          status: 'UNCERTAIN',
          lastErrorCode: 'ATTEMPT_ABANDONED',
        });
      }
    }
  });

  it('CRM succeeded but recording it failed: recovery uses the same key, no duplicate', async () => {
    const w = await leadWorld();
    const crm = new FakeCrm('native', ['ok', 'ok']);
    let failures = 3; // longer than the in-process retry of the success record
    const flaky = new Proxy(prisma, {
      get(target, property): unknown {
        if (property === '$transaction' && failures > 0) {
          failures -= 1;
          return (): Promise<never> =>
            Promise.reject(new Error('database unavailable'));
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function'
          ? (value as (...a: unknown[]) => unknown).bind(target)
          : value;
      },
    }) as PrismaService;
    const worker = new LeadSyncService(flaky, loaderFor(crm));
    await expect(worker.sync(w.tenantId, w.leadId)).rejects.toThrow(
      'database unavailable',
    );
    expect(crm.records).toHaveLength(1);
    expect(await op(w.tenantId, w.leadId)).toMatchObject({
      status: 'IN_FLIGHT',
    });
    // The queue redelivers immediately: the live lease blocks a second call.
    expect(await worker.sync(w.tenantId, w.leadId)).toBe('SKIPPED');
    const afterLease = later(new Date(), LEAD_SYNC_LEASE_MS + 1_000);
    expect(await worker.sync(w.tenantId, w.leadId, afterLease)).toBe('SYNCED');
    expect(crm.records).toHaveLength(1);
    expect(await leadRow(w.leadId)).toMatchObject({
      crmSyncStatus: 'SYNCED',
      crmLeadId: 'crm-1',
    });
  });

  it('a short database hiccup after success is absorbed: evidence kept, no retry', async () => {
    const w = await leadWorld();
    const crm = new FakeCrm('none', ['ok']);
    let failures = 1;
    const flaky = new Proxy(prisma, {
      get(target, property): unknown {
        if (property === '$transaction' && failures > 0) {
          failures -= 1;
          return (): Promise<never> =>
            Promise.reject(new Error('database unavailable'));
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function'
          ? (value as (...a: unknown[]) => unknown).bind(target)
          : value;
      },
    }) as PrismaService;
    expect(
      await new LeadSyncService(flaky, loaderFor(crm)).sync(
        w.tenantId,
        w.leadId,
      ),
    ).toBe('SYNCED');
    expect(crm.createCalls).toHaveLength(1);
    expect(await leadRow(w.leadId)).toMatchObject({
      crmSyncStatus: 'SYNCED',
      crmLeadId: 'crm-1',
    });
  });

  it('a worker that lost its lease cannot overwrite the recorded outcome', async () => {
    const w = await leadWorld();
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const crm = new FakeCrm('native', [{ hold }, 'ok']);
    const slow = new LeadSyncService(prisma, loaderFor(crm));
    const pending = slow.sync(w.tenantId, w.leadId);
    await new Promise((r) => setTimeout(r, 100));
    const fast = new LeadSyncService(
      db2 as unknown as PrismaService,
      loaderFor(crm),
    );
    expect(
      await fast.sync(
        w.tenantId,
        w.leadId,
        later(new Date(), LEAD_SYNC_LEASE_MS + 1_000),
      ),
    ).toBe('SYNCED');
    release();
    await pending;
    // Native dedup returned the same record to both; only the lease owner wrote state.
    expect(crm.records).toHaveLength(1);
    expect(await op(w.tenantId, w.leadId)).toMatchObject({
      status: 'SUCCEEDED',
      attempts: 2,
    });
  });

  it('attempts are bounded; an exhausted unclear write becomes UNCERTAIN, a definitive one FAILED', async () => {
    const native = await leadWorld();
    const crm = new FakeCrm('native', Array(8).fill('timeout-before-commit'));
    const sync = new LeadSyncService(prisma, loaderFor(crm));
    let now = new Date();
    let last = '';
    for (let i = 0; i < 8; i += 1) {
      last = await sync.sync(native.tenantId, native.leadId, now);
      const row = await op(native.tenantId, native.leadId);
      now = later(row.nextAttemptAt ?? now, 1);
    }
    expect(last).toBe('UNCERTAIN');
    expect(await op(native.tenantId, native.leadId)).toMatchObject({
      status: 'UNCERTAIN',
      attempts: 8,
    });

    const definitive = await leadWorld();
    const rejecting = new FakeCrm('none', Array(8).fill('reject'));
    const sync2 = new LeadSyncService(prisma, loaderFor(rejecting));
    now = new Date();
    for (let i = 0; i < 8; i += 1) {
      last = await sync2.sync(definitive.tenantId, definitive.leadId, now);
      const row = await op(definitive.tenantId, definitive.leadId);
      now = later(row.nextAttemptAt ?? now, 1);
    }
    expect(last).toBe('FAILED');
    expect(await op(definitive.tenantId, definitive.leadId)).toMatchObject({
      status: 'FAILED',
      attempts: 8,
    });
    expect(
      await sync2.sync(
        definitive.tenantId,
        definitive.leadId,
        later(now, 3_600_000),
      ),
    ).toBe('SKIPPED');
    expect(rejecting.createCalls).toHaveLength(8);
  });
});
