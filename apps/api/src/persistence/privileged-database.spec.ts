import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PrivilegedDatabase } from './privileged-database.js';
import { PersistenceModule } from './persistence.module.js';
import { PrismaService } from './prisma.service.js';

/**
 * Files allowed to use the privileged (cross-tenant) connection. Each new
 * entry is reviewed against the RLS plan: the code must span tenants (find
 * due work, route a webhook, look up a session) and then switch to the
 * tenant's own context for the work itself.
 */
const ALLOWED = new Map([
  ['persistence/persistence.module.ts', 'provides it'],
  ['persistence/privileged-database.ts', 'defines it'],
  // S5: identity is looked up before any tenant is known.
  ['webinbox/session.service.ts', 'login by e-mail, session by cookie hash'],
  ['auth/mfa.service.ts', 'second factor of a person not yet signed in'],
  ['handover/operator-auth.ts', 'operator API token found by its hash'],
  ['team/operator-invite.service.ts', 'invite found by its token alone'],
  ['team/password-reset.service.ts', 'reset link found by its token alone'],
  // S5: a webhook names the account; one lookup finds its tenant.
  ['channels/telegram/telegram-webhook.service.ts', 'route an update'],
  ['channels/instagram/instagram-webhook.service.ts', 'route a Meta event'],
  // S5b: the platform console works across tenants by design (ADR 047).
  ['platform/platform-auth.controller.ts', 'platform sign-in'],
  ['platform/platform-session.service.ts', 'platform sessions'],
  [
    'platform/platform-tenants.controller.ts',
    'tenants list and business segments, edit, delete',
  ],
  ['platform/platform-billing.controller.ts', 'subscriptions, payments'],
  [
    'platform/platform-plans.controller.ts',
    'plans and active-plan search/pagination for customer creation',
  ],
  ['platform/platform-admins.controller.ts', 'platform admins'],
  ['platform/platform-audit.controller.ts', 'platform audit log'],
  ['signup/signup.service.ts', 'self-serve signup creates a tenant (ADR 080)'],
  [
    'public/public-plans.controller.ts',
    'sales site plan list, before any tenant',
  ],
  ['signup/signup-cleanup.scan.ts', 'purges expired signups (platform table)'],

  [
    'billing/click-payments.service.ts',
    'Click callback finds its payment, then runs per tenant (ADR 082)',
  ],
  [
    'billing/payme-payments.service.ts',
    'Payme callbacks route an order; GetStatement spans the merchant (ADR 084)',
  ],
  ['platform/platform-overview.controller.ts', 'platform overview totals'],
  // S6: queues. The relay and the scheduler find due work of every tenant;
  // each job then runs under runWithTenant.
  ['channels/telegram/telegram-queue.runtime.ts', 'outbox relay'],
  ['connectors/sync/tenant-connector-loader.ts', 'connectors to schedule'],
  ['connectors/sync/catalog-sync.store.ts', 'stale runs of every tenant'],
  // S7: scheduled scans find due work of every tenant, then work per tenant.
  ['handover/digest.service.ts', 'tenants with an operator group'],
  ['observability/alerts.service.ts', 'tenants to check, platform alerts'],
  ['webinbox/inbox-events.service.ts', 'prunes the feed of every tenant'],
  ['connectors/spreadsheet/sheet-catalog.service.ts', 'lists due a reload'],
  ['followup/follow-up.service.ts', 'silent conversations to remind'],
  ['handover/operator-idle-return.service.ts', 'idle operator chats'],
  ['leads/lead-backfill.scan.ts', 'tenants not yet backfilled'],
  ['access/subscription-scan.service.ts', 'periods ending or ended'],
  ['access/lead-limit-scan.service.ts', 'plans with a lead limit'],
  ['tasks/lead-tasks.ts', 'tasks that fell due'],
  ['connectors/bitrix24/crm-stage-sync.service.ts', 'stage syncs due a poll'],
  [
    'telephony/call-poll.scan.ts',
    'connected PBX accounts due a poll (ADR 085)',
  ],
  ['leads/lead-sync.service.ts', 'CRM writes to retry or recover'],
  ['retention/retention.service.ts', 'tenants to purge'],
  ['actions/action.service.ts', 'stale proposals, retries, recoveries'],
  ['handover/handover-sla.service.ts', 'overdue handovers'],
  ['webinbox/inbox-event-bus.ts', 'one poller for every open stream'],
  // S9: refusing a bot, Page or account another tenant already connected.
  ['webinbox/telegram-connect.controller.ts', "another tenant's bot"],
  ['webinbox/facebook-connect.controller.ts', "another tenant's Page"],
  ['webinbox/instagram-connect.controller.ts', "another tenant's account"],
  // S8b: spec worlds wire the test owner in as the handle, as
  // PersistenceModule does (never imported by production code).
  ['actions/testing/lifecycle-runner.ts', 'lifecycle eval world'],
  ['agent/testing/simulation/world.ts', 'simulation world'],
  // S7: start-up check of the account this process serves.
  ['agent/agent-mode.startup.ts', 'served account before any tenant'],
]);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'generated') return [];
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith('.ts') && !name.endsWith('.spec.ts') ? [path] : [];
  });
}

const config = (values: Record<string, unknown>): never =>
  ({ get: (key: string): unknown => values[key] }) as never;

describe('privileged database (RLS plan S3)', () => {
  it('is used only where cross-tenant work is allowed', () => {
    const root = join(process.cwd(), 'src');
    const users = sources(root)
      .filter((path) =>
        readFileSync(path, 'utf8').includes('PrivilegedDatabase'),
      )
      .map((path) => relative(root, path));
    expect(users.filter((path) => !ALLOWED.has(path))).toEqual([]);
    // A stale entry would quietly allow a future use: keep the list exact.
    expect([...ALLOWED.keys()].filter((path) => !users.includes(path))).toEqual(
      [],
    );
  });

  it('comes from the same module as PrismaService, so services may take it as optional', () => {
    // Services fall back to PrismaService only when a spec builds them by
    // hand; under Nest both are always provided together.
    const exports = Reflect.getMetadata(
      'exports',
      PersistenceModule,
    ) as unknown[];
    expect(exports).toContain(PrismaService);
    expect(exports).toContain(PrivilegedDatabase);
  });

  it('is the main connection until a privileged role is configured', () => {
    const main = { marker: 'main' } as unknown as PrismaService;
    const shared = new PrivilegedDatabase(config({}), main);
    expect(shared.db).toBe(main);
    expect(shared.separate).toBe(false);
  });

  it('opens its own pool as the configured role, defaults from the main settings', () => {
    const main = { marker: 'main' } as unknown as PrismaService;
    const own = new PrivilegedDatabase(
      config({
        POSTGRES_HOST: 'db',
        POSTGRES_PORT: 5432,
        POSTGRES_DATABASE: 'agentcore',
        POSTGRES_SSL_MODE: 'disable',
        POSTGRES_ADMIN_USER: 'owner_role',
        POSTGRES_ADMIN_PASSWORD: 'not-a-real-secret',
      }),
      main,
    );
    expect(own.separate).toBe(true);
    expect(own.db).not.toBe(main);
  });
});
