import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * Action-lifecycle evaluation cases (Phase 7.2). Each case drives the real
 * pipeline through several customer messages and executions with a scripted
 * CRM, and is scored on database state, CRM writes and every customer
 * message. Pure schema here so the coverage gate can count cases without a
 * database; the runner lives in src/actions/testing.
 */
const ModelStep = z.union([
  z
    .object({
      kind: z.literal('extract'),
      slots: z.record(z.string(), z.string().nullable()).default({}),
      intent: z.string().default('other'),
      language: z.string(),
      script: z.string(),
    })
    .strict(),
  z.object({ kind: z.literal('respond'), text: z.string() }).strict(),
]);

const Step = z.union([
  z
    .object({
      say: z.string(),
      tenant: z.enum(['A', 'B']).default('A'),
      /** Telegram delivers the previous update again (same update id). */
      redeliver: z.boolean().default(false),
      model: z.array(ModelStep).default([]),
    })
    .strict(),
  z
    .object({
      /** Run the queued executions; `untilFinal` follows retries to the end. */
      execute: z.enum(['once', 'twice', 'concurrent', 'untilFinal']),
      tenant: z.enum(['A', 'B']).default('A'),
    })
    .strict(),
  z.object({ revokePolicy: z.literal(true) }).strict(),
  z.object({ operatorTakesOver: z.literal(true) }).strict(),
  /** Tenant B's worker tries to execute tenant A's proposal. */
  z.object({ crossTenantExecute: z.literal(true) }).strict(),
]);

export const LIFECYCLE_MESSAGES = [
  'succeeded',
  'succeededWithReference',
  'received',
  'declined',
  'expired',
  'proposal',
  'phoneRequest',
  'askName',
  'question',
  'answer',
  'ACTION_FAILED',
  'ACTION_OUTCOME_UNKNOWN',
  'none',
] as const;

export const LifecycleCaseSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/u),
    pack: z.enum(['education', 'travel']),
    locale: z.enum(['uz-Latn', 'uz-Cyrl', 'ru', 'en']),
    category: z.enum([
      'action_confirm',
      'action_decline',
      'action_failure',
      'duplicate_request',
      'tenant_isolation',
      'authorization',
      'shadow_mode',
    ]),
    description: z.string().min(1),
    agentMode: z.enum(['LIVE', 'SHADOW']).default('LIVE'),
    tenant: z
      .object({
        actionMode: z.enum(['live', 'off']).default('live'),
        allowUnprotectedConnector: z.boolean().default(false),
      })
      .strict()
      .default({ actionMode: 'live', allowUnprotectedConnector: false }),
    crm: z
      .object({
        idempotency: z.enum(['native', 'lookup', 'none']),
        writes: z
          .array(
            z.enum([
              'ok',
              'reject',
              'commit-then-timeout',
              'timeout-before-commit',
            ]),
          )
          .default([]),
      })
      .strict(),
    contact: z
      .object({ name: z.string().optional(), phone: z.string().optional() })
      .strict()
      .default({}),
    steps: z.array(Step).min(1),
    expect: z
      .object({
        /** Tenant A's proposals, oldest first. */
        proposals: z.array(z.string()),
        /** Records the CRM really holds, and write calls it received. */
        crmRecords: z.number().int().min(0),
        crmCalls: z.number().int().min(0),
        lastMessage: z.enum(LIFECYCLE_MESSAGES),
        handover: z.string().nullable().default(null),
        /** Tenant B ends with no proposals, operations or CRM calls. */
        otherTenantUntouched: z.boolean().default(false),
      })
      .strict(),
  })
  .strict();

export type LifecycleCase = z.infer<typeof LifecycleCaseSchema>;

export function loadLifecycleCases(root: string): LifecycleCase[] {
  const cases: LifecycleCase[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith('.json'))
        for (const entry of JSON.parse(readFileSync(path, 'utf8')) as unknown[])
          cases.push(LifecycleCaseSchema.parse(entry));
    }
  };
  walk(root);
  const ids = new Set<string>();
  for (const item of cases) {
    if (ids.has(item.id))
      throw new Error(`Duplicate lifecycle case ${item.id}`);
    ids.add(item.id);
  }
  return cases;
}
