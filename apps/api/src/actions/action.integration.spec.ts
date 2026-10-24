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
} from '../connectors/interfaces/errors.js';
import type { TenantConnectorLoader } from '../connectors/sync/tenant-connector-loader.js';
import {
  proposalDigest,
  type ActionDecision,
} from '../core/actions/actions.js';
import { PrismaClient } from '../generated/prisma/client.js';
import { HandoverService } from '../handover/handover.service.js';
import { LeadSyncService } from '../leads/lead-sync.service.js';
import { UZ_LATN } from '../locales/locale-packs.js';
import { createPostgresAdapter } from '../persistence/postgres-adapter.js';
import type { PrismaService } from '../persistence/prisma.service.js';
import { ACTION_LEASE_MS, ActionService } from './action.service.js';

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test')
  throw new Error('requires agentcore_test');
const db = new PrismaClient({
  adapter: createPostgresAdapter(process.env, 'TEST_'),
});
const db2 = new PrismaClient({
  adapter: createPostgresAdapter(process.env, 'TEST_'),
});
const prisma = db as unknown as PrismaService;
afterAll(async () => {
  await db.$disconnect();
  await db2.$disconnect();
});

type Step = 'ok' | 'reject' | 'commit-then-timeout' | { hold: Promise<void> };

class FakeCrm {
  readonly records: { id: string; key?: string; input: LeadInput }[] = [];
  readonly calls: (string | undefined)[] = [];
  constructor(
    readonly mode: WriteIdempotency,
    private readonly steps: Step[] = [],
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
    } as CrmConnector;
  }
  private store(input: LeadInput, key?: string): string {
    const existing =
      this.mode === 'native' && key
        ? this.records.find((r) => r.key === key)
        : undefined;
    if (existing) return existing.id;
    const id = `crm-${this.records.length + 1}`;
    this.records.push({ id, key, input });
    return id;
  }
  private async create(
    input: LeadInput,
    context?: WriteContext,
  ): Promise<{ crmLeadId: string }> {
    this.calls.push(context?.idempotencyKey);
    const step = this.steps.shift() ?? 'ok';
    if (step === 'reject')
      throw new ConnectorError({
        message: 'invalid',
        code: 'CONNECTOR_REQUEST_FAILED',
        category: ConnectorErrorCategory.VALIDATION,
      });
    if (step === 'commit-then-timeout') {
      this.store(input, context?.idempotencyKey);
      throw new ConnectorTimeoutError({ message: 'timeout' });
    }
    if (typeof step === 'object') await step.hold;
    return { crmLeadId: this.store(input, context?.idempotencyKey) };
  }
}

const CONSENT = {
  'uz-Latn': 'Telefon raqamingiz va tanlovingiz markazga yuboriladi.',
  'uz-Cyrl': 'Телефон рақамингиз ва танловингиз марказга юборилади.',
  ru: 'Ваш номер и выбор будут переданы центру.',
  en: 'Your number and choices will be sent to the centre.',
};
const PAYLOAD = {
  'slots.subject': 'IELTS',
  'slots.preferredTime': 'morning',
  'contact.phone': '+998901234567',
};

interface World {
  tenantId: string;
  conversationId: string;
  accountId: string;
}

async function world(
  options: { actions?: Record<string, unknown>; mode?: 'LIVE' | 'SHADOW' } = {},
): Promise<World> {
  const suffix = randomUUID();
  const tenant = await db.tenant.create({
    data: {
      slug: `act-${suffix}`,
      name: 'Action fixture',
      defaultLocale: 'uz-Latn',
      supportedLocales: ['uz-Latn', 'uz-Cyrl', 'ru', 'en'],
      timezone: 'UTC',
      packKey: 'education',
      packVersion: '1',
      config: {
        actions: options.actions ?? {
          course_enquiry: { mode: 'live', consent: CONSENT },
        },
      } as never,
    },
  });
  const account = await db.channelAccount.create({
    data: {
      tenantId: tenant.id,
      channelType: 'telegram',
      externalAccountId: `act-${suffix}`,
      status: 'ACTIVE',
      agentMode: options.mode ?? 'LIVE',
    },
  });
  const contact = await db.contact.create({
    data: {
      tenantId: tenant.id,
      channelAccountId: account.id,
      providerUserId: `u-${suffix}`,
      phone: '+998901234567',
    },
  });
  const conversation = await db.conversation.create({
    data: {
      tenantId: tenant.id,
      channelAccountId: account.id,
      contactId: contact.id,
      providerChatId: `c-${suffix}`,
      language: 'uz',
      script: 'Latn',
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
  return {
    tenantId: tenant.id,
    conversationId: conversation.id,
    accountId: account.id,
  };
}

const service = (crm: FakeCrm, client: PrismaClient = db): ActionService =>
  new ActionService(
    client as unknown as PrismaService,
    { create: () => crm.connector() } as unknown as TenantConnectorLoader,
    new HandoverService(client as unknown as PrismaService),
    { get: () => 10 } as never,
  );

async function decide(
  actions: ActionService,
  w: World,
  decision: ActionDecision,
  now = new Date(),
): Promise<{ expired?: true }> {
  return db.$transaction((tx) =>
    actions.applyDecision(tx, {
      tenantId: w.tenantId,
      conversationId: w.conversationId,
      decision,
      packRef: 'education@1',
      turnKey: `turn-${randomUUID()}`,
      now,
    }),
  );
}

const digest = (w: World, payload = PAYLOAD): string =>
  proposalDigest(
    {
      tenantId: w.tenantId,
      conversationId: w.conversationId,
      packRef: 'education@1',
    },
    'course_enquiry',
    payload,
  );

async function proposeAndConfirm(
  actions: ActionService,
  w: World,
): Promise<string> {
  await decide(actions, w, {
    kind: 'PROPOSE',
    actionKey: 'course_enquiry',
    payload: PAYLOAD,
    digest: digest(w),
    expiresAfterMinutes: 30,
  });
  const proposal = await db.actionProposal.findFirstOrThrow({
    where: { tenantId: w.tenantId, status: 'PROPOSED' },
  });
  expect(
    await decide(actions, w, {
      kind: 'CONFIRM',
      proposalId: proposal.id,
      digest: proposal.digest,
    }),
  ).toEqual({});
  return proposal.id;
}

const outbound = (w: World): Promise<string[]> =>
  db.message
    .findMany({
      where: { tenantId: w.tenantId, direction: 'OUTBOUND' },
      orderBy: { sequence: 'asc' },
    })
    .then((rows) => rows.map((row) => row.text));

describe('which actions are available', () => {
  it('only live actions, through a protected connector, with consent for contact data', async () => {
    const native = new FakeCrm('native');
    const none = new FakeCrm('none');
    const pack = (await import('../packs/registry.js')).DOMAIN_PACKS.get(
      'education@1',
    )!;
    const on = await world();
    expect(
      (await service(native).available(on.tenantId, pack)).candidates.map(
        (c) => c.spec.key,
      ),
    ).toEqual(['course_enquiry']);
    // D-2: an unprotected connector is not used unless the tenant explicitly allows it.
    expect(
      (await service(none).available(on.tenantId, pack)).candidates,
    ).toEqual([]);
    const allowed = await world({
      actions: {
        course_enquiry: {
          mode: 'live',
          consent: CONSENT,
          allowUnprotectedConnector: true,
        },
      },
    });
    expect(
      (await service(none).available(allowed.tenantId, pack)).candidates,
    ).toHaveLength(1);
    // D-5: contact data needs consent text in every pack locale.
    const noConsent = await world({
      actions: { course_enquiry: { mode: 'live' } },
    });
    expect(
      (await service(native).available(noConsent.tenantId, pack)).candidates,
    ).toEqual([]);
    const partial = await world({
      actions: { course_enquiry: { mode: 'live', consent: { en: 'x' } } },
    });
    expect(
      (await service(native).available(partial.tenantId, pack)).candidates,
    ).toEqual([]);
    const off = await world({
      actions: { course_enquiry: { mode: 'off', consent: CONSENT } },
    });
    expect(
      (await service(native).available(off.tenantId, pack)).candidates,
    ).toEqual([]);
    const absent = await world({ actions: {} });
    expect(
      (await service(native).available(absent.tenantId, pack)).candidates,
    ).toEqual([]);
  });
});

describe('proposal and confirmation', () => {
  it('stores only declared fields; audit keeps field names, never values', async () => {
    const w = await world();
    const actions = service(new FakeCrm('native'));
    await decide(actions, w, {
      kind: 'PROPOSE',
      actionKey: 'course_enquiry',
      payload: PAYLOAD,
      digest: digest(w),
      expiresAfterMinutes: 30,
    });
    const row = await db.actionProposal.findFirstOrThrow({
      where: { tenantId: w.tenantId },
    });
    expect(row).toMatchObject({
      status: 'PROPOSED',
      payload: PAYLOAD,
      digest: digest(w),
      operation: 'createLead',
    });
    const audit = await db.auditEvent.findFirstOrThrow({
      where: { tenantId: w.tenantId, action: 'action.proposed' },
    });
    expect(JSON.stringify(audit.safeInputSummary)).not.toContain('+998');
    expect(JSON.stringify(audit.safeInputSummary)).not.toContain('IELTS');
  });

  it('a new proposal supersedes the open one; only one is ever open', async () => {
    const w = await world();
    const actions = service(new FakeCrm('native'));
    await decide(actions, w, {
      kind: 'PROPOSE',
      actionKey: 'course_enquiry',
      payload: PAYLOAD,
      digest: digest(w),
      expiresAfterMinutes: 30,
    });
    const changed = { ...PAYLOAD, 'slots.preferredTime': 'evening' };
    await decide(actions, w, {
      kind: 'PROPOSE',
      actionKey: 'course_enquiry',
      payload: changed,
      digest: digest(w, changed),
      expiresAfterMinutes: 30,
    });
    const rows = await db.actionProposal.findMany({
      where: { tenantId: w.tenantId },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows.map((r) => r.status)).toEqual(['SUPERSEDED', 'PROPOSED']);
    expect(rows[0].payload).toBeNull();
    // The old proposal can no longer be confirmed: changed details never execute.
    expect(
      await decide(actions, w, {
        kind: 'CONFIRM',
        proposalId: rows[0].id,
        digest: rows[0].digest,
      }),
    ).toEqual({ expired: true });
    await expect(
      db.actionProposal.create({
        data: {
          tenantId: w.tenantId,
          conversationId: w.conversationId,
          actionKey: 'course_enquiry',
          operation: 'createLead',
          packRef: 'education@1',
          digest: 'x',
          expiresAt: new Date(Date.now() + 60_000),
          proposedTurnKey: `t-${randomUUID()}`,
        },
      }),
    ).rejects.toThrow();
  });

  it('refuses a wrong digest, an expired proposal, a declined one and another tenant', async () => {
    const w = await world();
    const other = await world();
    const actions = service(new FakeCrm('native'));
    await decide(actions, w, {
      kind: 'PROPOSE',
      actionKey: 'course_enquiry',
      payload: PAYLOAD,
      digest: digest(w),
      expiresAfterMinutes: 30,
    });
    const p = await db.actionProposal.findFirstOrThrow({
      where: { tenantId: w.tenantId },
    });
    expect(
      await decide(actions, w, {
        kind: 'CONFIRM',
        proposalId: p.id,
        digest: 'f'.repeat(64),
      }),
    ).toEqual({ expired: true });
    expect(
      await decide(actions, other, {
        kind: 'CONFIRM',
        proposalId: p.id,
        digest: p.digest,
      }),
    ).toEqual({ expired: true });
    expect(
      await decide(
        actions,
        w,
        { kind: 'CONFIRM', proposalId: p.id, digest: p.digest },
        new Date(Date.now() + 31 * 60_000),
      ),
    ).toEqual({ expired: true });
    await decide(actions, w, { kind: 'DECLINE', proposalId: p.id });
    expect(
      await decide(actions, w, {
        kind: 'CONFIRM',
        proposalId: p.id,
        digest: p.digest,
      }),
    ).toEqual({ expired: true });
    expect(
      await db.connectorOperation.count({ where: { tenantId: w.tenantId } }),
    ).toBe(0);
    expect(
      await db.outboxEvent.count({
        where: { tenantId: w.tenantId, type: 'action.execute' },
      }),
    ).toBe(0);
  });

  it('a duplicate confirmation delivery creates one operation and one queued execution', async () => {
    const w = await world();
    const actions = service(new FakeCrm('native'));
    const id = await proposeAndConfirm(actions, w);
    const p = await db.actionProposal.findFirstOrThrow({ where: { id } });
    expect(
      await decide(actions, w, {
        kind: 'CONFIRM',
        proposalId: id,
        digest: p.digest,
      }),
    ).toEqual({ expired: true });
    expect(
      await db.connectorOperation.count({ where: { tenantId: w.tenantId } }),
    ).toBe(1);
    expect(
      await db.outboxEvent.count({
        where: { tenantId: w.tenantId, type: 'action.execute' },
      }),
    ).toBe(1);
    expect(
      await db.auditEvent.count({
        where: { tenantId: w.tenantId, action: 'action.confirmed' },
      }),
    ).toBe(1);
  });
});

describe('execution', () => {
  it('success: one CRM record, evidence kept, payload cleared, verified message, lead linked', async () => {
    const w = await world();
    const crm = new FakeCrm('native');
    const actions = service(crm);
    const id = await proposeAndConfirm(actions, w);
    expect(await actions.execute(w.tenantId, id)).toBe('SUCCEEDED');
    expect(await actions.execute(w.tenantId, id)).toBe('SKIPPED');
    expect(crm.records).toHaveLength(1);
    expect(crm.records[0].input).toMatchObject({
      contact: { phone: '+998901234567' },
      slots: { subject: 'IELTS', preferredTime: 'morning' },
    });
    expect(crm.records[0].input.contact).not.toHaveProperty('name');
    expect(crm.calls).toEqual([`createLead:action_proposal:${id}`]);
    expect(
      await db.actionProposal.findUniqueOrThrow({ where: { id } }),
    ).toMatchObject({
      status: 'SUCCEEDED',
      externalId: 'crm-1',
      payload: null,
    });
    expect(await outbound(w)).toEqual([UZ_LATN.templates.actions.succeeded]);
    expect(
      await db.outboxEvent.count({
        where: { tenantId: w.tenantId, type: 'telegram.send' },
      }),
    ).toBe(1);
    // A later handover lead for this conversation is linked, never created again.
    const conversation = await db.conversation.findUniqueOrThrow({
      where: { id: w.conversationId },
    });
    const lead = await db.lead.create({
      data: {
        tenantId: w.tenantId,
        contactId: conversation.contactId,
        conversationId: w.conversationId,
        score: 'HOT',
        summary: 's',
        requirements: {},
        idempotencyKey: `lead-${randomUUID()}`,
      },
    });
    const leadCrm = new FakeCrm('native');
    expect(
      await new LeadSyncService(prisma, {
        create: () => leadCrm.connector(),
      } as unknown as TenantConnectorLoader).sync(w.tenantId, lead.id),
    ).toBe('SKIPPED');
    expect(leadCrm.calls).toHaveLength(0);
    expect(
      await db.lead.findUniqueOrThrow({ where: { id: lead.id } }),
    ).toMatchObject({ crmSyncStatus: 'SYNCED', crmLeadId: 'crm-1' });
  });

  it('a definitive failure is retried with the same key and then succeeds, telling the customer once', async () => {
    const w = await world();
    const crm = new FakeCrm('native', ['reject', 'ok']);
    const actions = service(crm);
    const id = await proposeAndConfirm(actions, w);
    expect(await actions.execute(w.tenantId, id)).toBe('RETRY_WAIT');
    expect(await outbound(w)).toEqual([]);
    const op = await db.connectorOperation.findFirstOrThrow({
      where: { tenantId: w.tenantId },
    });
    expect(
      await actions.execute(
        w.tenantId,
        id,
        new Date(op.nextAttemptAt!.getTime() + 1),
      ),
    ).toBe('SUCCEEDED');
    expect(new Set(crm.calls)).toEqual(
      new Set([`createLead:action_proposal:${id}`]),
    );
    expect(crm.records).toHaveLength(1);
    expect(await outbound(w)).toEqual([UZ_LATN.templates.actions.succeeded]);
  });

  it('native: a lost response is retried with the same key; still one record', async () => {
    const w = await world();
    const crm = new FakeCrm('native', ['commit-then-timeout', 'ok']);
    const actions = service(crm);
    const id = await proposeAndConfirm(actions, w);
    expect(await actions.execute(w.tenantId, id)).toBe('RETRY_WAIT');
    const op = await db.connectorOperation.findFirstOrThrow({
      where: { tenantId: w.tenantId },
    });
    expect(
      await actions.execute(
        w.tenantId,
        id,
        new Date(op.nextAttemptAt!.getTime() + 1),
      ),
    ).toBe('SUCCEEDED');
    expect(crm.records).toHaveLength(1);
    expect(crm.calls).toHaveLength(2);
  });

  it('none (explicitly allowed): an unclear outcome is UNCERTAIN, handed over, never retried, never called success', async () => {
    const w = await world({
      actions: {
        course_enquiry: {
          mode: 'live',
          consent: CONSENT,
          allowUnprotectedConnector: true,
        },
      },
    });
    const crm = new FakeCrm('none', ['commit-then-timeout']);
    const actions = service(crm);
    const id = await proposeAndConfirm(actions, w);
    expect(await actions.execute(w.tenantId, id)).toBe('UNCERTAIN');
    expect(
      await actions.execute(w.tenantId, id, new Date(Date.now() + 86_400_000)),
    ).toBe('SKIPPED');
    expect(crm.calls).toHaveLength(1);
    const proposal = await db.actionProposal.findUniqueOrThrow({
      where: { id },
    });
    expect(proposal).toMatchObject({ status: 'UNCERTAIN', externalId: null });
    expect(proposal.payload).toEqual(PAYLOAD); // kept for the person who checks
    expect(await outbound(w)).toEqual([
      UZ_LATN.templates.handover.ACTION_OUTCOME_UNKNOWN,
    ]);
    expect(
      await db.handover.findFirstOrThrow({ where: { tenantId: w.tenantId } }),
    ).toMatchObject({ reasonCode: 'ACTION_OUTCOME_UNKNOWN' });
    expect(
      (
        await db.conversation.findUniqueOrThrow({
          where: { id: w.conversationId },
        })
      ).state,
    ).toBe('WAITING_OPERATOR');

    // A person resolves it: tenant-scoped, needs evidence, audited, payload cleared.
    const other = await world();
    expect(
      await actions.resolveUncertain({
        tenantId: other.tenantId,
        proposalId: id,
        outcome: 'SUCCEEDED',
        externalId: 'crm-1',
        actor: 'op',
      }),
    ).toBe('NOT_UNCERTAIN');
    expect(
      await actions.resolveUncertain({
        tenantId: w.tenantId,
        proposalId: id,
        outcome: 'SUCCEEDED',
        actor: 'op',
      }),
    ).toBe('MISSING_EVIDENCE');
    expect(
      await actions.resolveUncertain({
        tenantId: w.tenantId,
        proposalId: id,
        outcome: 'SUCCEEDED',
        externalId: 'crm-1',
        actor: 'op',
      }),
    ).toBe('RESOLVED');
    expect(
      await db.actionProposal.findUniqueOrThrow({ where: { id } }),
    ).toMatchObject({
      status: 'SUCCEEDED',
      externalId: 'crm-1',
      payload: null,
    });
    expect(
      await db.auditEvent.count({
        where: { tenantId: w.tenantId, action: 'action.resolved' },
      }),
    ).toBe(1);
  });

  it('policy revoked after confirmation: nothing is written; a cancel is honest', async () => {
    const w = await world();
    const crm = new FakeCrm('native');
    const actions = service(crm);
    const id = await proposeAndConfirm(actions, w);
    await db.tenant.update({
      where: { id: w.tenantId },
      data: { config: { actions: { course_enquiry: { mode: 'off' } } } },
    });
    expect(await actions.execute(w.tenantId, id)).toBe('CANCELLED');
    expect(crm.calls).toHaveLength(0);
    expect(
      await db.actionProposal.findUniqueOrThrow({ where: { id } }),
    ).toMatchObject({ status: 'CANCELLED', payload: null });
    expect(await outbound(w)).toEqual([
      UZ_LATN.templates.handover.ACTION_FAILED,
    ]);
  });

  it('policy revoked after an unclear attempt: UNCERTAIN, not cancelled', async () => {
    const w = await world();
    const crm = new FakeCrm('native', ['commit-then-timeout']);
    const actions = service(crm);
    const id = await proposeAndConfirm(actions, w);
    expect(await actions.execute(w.tenantId, id)).toBe('RETRY_WAIT');
    await db.channelAccount.update({
      where: { id: w.accountId },
      data: { agentMode: 'SHADOW' },
    });
    const op = await db.connectorOperation.findFirstOrThrow({
      where: { tenantId: w.tenantId },
    });
    expect(
      await actions.execute(
        w.tenantId,
        id,
        new Date(op.nextAttemptAt!.getTime() + 1),
      ),
    ).toBe('UNCERTAIN');
    expect(crm.calls).toHaveLength(1);
    expect(
      await db.actionProposal.findUniqueOrThrow({ where: { id } }),
    ).toMatchObject({ status: 'UNCERTAIN' });
  });

  it('while an operator owns the conversation the bot sends no outcome message', async () => {
    const w = await world();
    const actions = service(new FakeCrm('native'));
    const id = await proposeAndConfirm(actions, w);
    await db.conversation.update({
      where: { id: w.conversationId },
      data: { state: 'OPERATOR_ACTIVE' },
    });
    expect(await actions.execute(w.tenantId, id)).toBe('SUCCEEDED');
    expect(await outbound(w)).toEqual([]);
  });

  it('two workers on the same queued execution: one CRM call', async () => {
    const w = await world();
    let release!: () => void;
    const hold = new Promise<void>((done) => (release = done));
    const crm = new FakeCrm('native', [{ hold }]);
    const one = service(crm);
    const two = service(crm, db2);
    const id = await proposeAndConfirm(one, w);
    const first = one.execute(w.tenantId, id);
    await new Promise((done) => setTimeout(done, 100));
    expect(
      await Promise.all([
        two.execute(w.tenantId, id),
        two.execute(w.tenantId, id),
      ]),
    ).toEqual(['SKIPPED', 'SKIPPED']);
    release();
    expect(await first).toBe('SUCCEEDED');
    expect(crm.calls).toHaveLength(1);
    expect(await outbound(w)).toHaveLength(1);
  });

  it('another tenant cannot execute or resolve a proposal', async () => {
    const w = await world();
    const other = await world();
    const crm = new FakeCrm('native');
    const actions = service(crm);
    const id = await proposeAndConfirm(actions, w);
    expect(await actions.execute(other.tenantId, id)).toBe('SKIPPED');
    expect(crm.calls).toHaveLength(0);
  });

  it('the scan expires stale proposals and re-queues due retries and abandoned attempts', async () => {
    const w = await world();
    const actions = service(new FakeCrm('native', ['reject']));
    await decide(actions, w, {
      kind: 'PROPOSE',
      actionKey: 'course_enquiry',
      payload: PAYLOAD,
      digest: digest(w),
      expiresAfterMinutes: 30,
    });
    const later = new Date(Date.now() + 31 * 60_000);
    await actions.scanDue(later);
    expect(
      await db.actionProposal.findFirstOrThrow({
        where: { tenantId: w.tenantId },
      }),
    ).toMatchObject({ status: 'EXPIRED', payload: null });

    const v = await world();
    const id = await proposeAndConfirm(actions, v);
    expect(await actions.execute(v.tenantId, id)).toBe('RETRY_WAIT');
    const op = await db.connectorOperation.findFirstOrThrow({
      where: { tenantId: v.tenantId },
    });
    await actions.scanDue(new Date(op.nextAttemptAt!.getTime() + 1));
    expect(
      await db.outboxEvent.count({
        where: { tenantId: v.tenantId, type: 'action.execute' },
      }),
    ).toBe(2);

    const z = await world();
    const dead = new FakeCrm('native', [
      { hold: new Promise<void>(() => undefined) },
    ]);
    const zid = await proposeAndConfirm(service(dead), z);
    void service(dead).execute(z.tenantId, zid);
    await new Promise((done) => setTimeout(done, 100));
    await actions.scanDue(new Date(Date.now() + ACTION_LEASE_MS + 1_000));
    expect(
      await db.outboxEvent.count({
        where: { tenantId: z.tenantId, type: 'action.execute' },
      }),
    ).toBe(2);
  });
});
