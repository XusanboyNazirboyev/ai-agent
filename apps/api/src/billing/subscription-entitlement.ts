import type { Prisma, SubscriptionStatus } from '../generated/prisma/client.js';
import { addDays, extendedPeriodEnd } from './click-rules.js';

const OPEN = ['TRIAL', 'ACTIVE', 'PAST_DUE'] as const;

interface PreviousSubscription {
  readonly planId: string;
  readonly status: SubscriptionStatus;
  readonly currentPeriodStart: string;
  readonly currentPeriodEnd: string;
  readonly graceUntil: string | null;
  readonly canceledAt: string | null;
}

export interface EntitlementSnapshot {
  readonly version: 1;
  readonly subscriptionId: string;
  readonly created: boolean;
  readonly periodDays: number;
  readonly appliedAt: string;
  readonly previous: PreviousSubscription | null;
}

export interface AppliedEntitlement {
  readonly subscriptionId: string;
  readonly periodEnd: Date;
  readonly planCode: string;
  readonly planPriceMinor: bigint;
  readonly wasOpen: SubscriptionStatus | null;
  readonly snapshot: EntitlementSnapshot;
}

/** Apply one paid order. The caller owns the payment state transition. */
export async function applySubscriptionEntitlement(
  tx: Prisma.TransactionClient,
  input: {
    tenantId: string;
    paymentId: string;
    planId: string;
    now: Date;
  },
): Promise<AppliedEntitlement> {
  const plan = await tx.subscriptionPlan.findUnique({
    where: { id: input.planId },
  });
  if (!plan) throw new Error('PLAN_MISSING');
  const open = await tx.tenantSubscription.findFirst({
    where: { tenantId: input.tenantId, status: { in: [...OPEN] } },
  });
  const previous: PreviousSubscription | null = open
    ? {
        planId: open.planId,
        status: open.status,
        currentPeriodStart: open.currentPeriodStart.toISOString(),
        currentPeriodEnd: open.currentPeriodEnd.toISOString(),
        graceUntil: open.graceUntil?.toISOString() ?? null,
        canceledAt: open.canceledAt?.toISOString() ?? null,
      }
    : null;
  let subscriptionId: string;
  let periodEnd: Date;
  if (open) {
    periodEnd = extendedPeriodEnd(
      open.currentPeriodEnd,
      plan.periodDays,
      input.now,
    );
    await tx.tenantSubscription.update({
      where: { id: open.id },
      data: {
        status: 'ACTIVE',
        planId: plan.id,
        graceUntil: null,
        canceledAt: null,
        currentPeriodEnd: periodEnd,
        ...(open.status === 'ACTIVE' ? {} : { currentPeriodStart: input.now }),
      },
    });
    subscriptionId = open.id;
  } else {
    periodEnd = addDays(input.now, plan.periodDays);
    const started = await tx.tenantSubscription.create({
      data: {
        tenantId: input.tenantId,
        planId: plan.id,
        status: 'ACTIVE',
        currentPeriodStart: input.now,
        currentPeriodEnd: periodEnd,
      },
    });
    subscriptionId = started.id;
  }
  await tx.subscriptionPayment.update({
    where: { id: input.paymentId },
    data: { subscriptionId },
  });
  return {
    subscriptionId,
    periodEnd,
    planCode: plan.code,
    planPriceMinor: plan.priceMinor,
    wasOpen: open?.status ?? null,
    snapshot: {
      version: 1,
      subscriptionId,
      created: !open,
      periodDays: plan.periodDays,
      appliedAt: input.now.toISOString(),
      previous,
    },
  };
}

function date(value: unknown): Date | undefined {
  if (typeof value !== 'string') return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/** Parse only the fields we wrote; provider payloads never enter the snapshot. */
export function parseEntitlementSnapshot(
  value: unknown,
): EntitlementSnapshot | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined;
  const row = value as Record<string, unknown>;
  if (
    row.version !== 1 ||
    typeof row.subscriptionId !== 'string' ||
    typeof row.created !== 'boolean' ||
    !Number.isInteger(row.periodDays) ||
    Number(row.periodDays) <= 0 ||
    !date(row.appliedAt)
  )
    return undefined;
  let previous: PreviousSubscription | null = null;
  if (row.previous !== null) {
    if (
      !row.previous ||
      typeof row.previous !== 'object' ||
      Array.isArray(row.previous)
    )
      return undefined;
    const before = row.previous as Record<string, unknown>;
    const status = before.status;
    if (
      typeof before.planId !== 'string' ||
      !OPEN.includes(status as (typeof OPEN)[number]) ||
      !date(before.currentPeriodStart) ||
      !date(before.currentPeriodEnd) ||
      (before.graceUntil !== null && !date(before.graceUntil)) ||
      (before.canceledAt !== null && !date(before.canceledAt))
    )
      return undefined;
    previous = {
      planId: before.planId,
      status: status as SubscriptionStatus,
      currentPeriodStart: before.currentPeriodStart as string,
      currentPeriodEnd: before.currentPeriodEnd as string,
      graceUntil: before.graceUntil as string | null,
      canceledAt: before.canceledAt as string | null,
    };
  }
  return {
    version: 1,
    subscriptionId: row.subscriptionId,
    created: row.created,
    periodDays: Number(row.periodDays),
    appliedAt: row.appliedAt as string,
    previous,
  };
}

/** Reverse one refunded order without erasing a later paid extension. */
export async function reverseSubscriptionEntitlement(
  tx: Prisma.TransactionClient,
  input: {
    tenantId: string;
    paymentId: string;
    snapshot: EntitlementSnapshot;
    now: Date;
  },
): Promise<void> {
  const subscription = await tx.tenantSubscription.findFirst({
    where: {
      id: input.snapshot.subscriptionId,
      tenantId: input.tenantId,
    },
  });
  if (!subscription) throw new Error('SUBSCRIPTION_MISSING');
  const refundedPayments = await tx.subscriptionPayment.findMany({
    where: {
      tenantId: input.tenantId,
      subscriptionId: subscription.id,
      provider: 'PAYME',
      status: 'REFUNDED',
    },
    select: { id: true },
  });
  const refundedTransactions = await tx.paymeTransaction.findMany({
    where: { paymentId: { in: refundedPayments.map((row) => row.id) } },
    orderBy: [{ performTime: 'asc' }, { id: 'asc' }],
    select: { entitlementSnapshot: true },
  });
  const baseline = refundedTransactions
    .map((row) => parseEntitlementSnapshot(row.entitlementSnapshot))
    .find((row) => row !== undefined);
  if (!baseline) throw new Error('ENTITLEMENT_SNAPSHOT_INVALID');
  const baselineAt = new Date(baseline.appliedAt);
  const remainingPaid = await tx.subscriptionPayment.findMany({
    where: {
      tenantId: input.tenantId,
      subscriptionId: subscription.id,
      status: 'PAID',
      paidAt: { gte: baselineAt },
    },
    orderBy: [{ paidAt: 'desc' }, { createdAt: 'desc' }],
    select: { provider: true, safeSummary: true },
  });
  const latestAutomated = remainingPaid.find(
    (row) => row.provider === 'CLICK' || row.provider === 'PAYME',
  );
  const latestSummary = (latestAutomated?.safeSummary ?? {}) as {
    planId?: unknown;
  };
  const latestPlanId =
    typeof latestSummary.planId === 'string' ? latestSummary.planId : undefined;
  const periodEnd = addDays(
    subscription.currentPeriodEnd,
    -input.snapshot.periodDays,
  );
  if (latestPlanId) {
    await tx.tenantSubscription.update({
      where: { id: subscription.id },
      data: {
        planId: latestPlanId,
        status: 'ACTIVE',
        graceUntil: null,
        canceledAt: null,
        currentPeriodEnd: periodEnd,
      },
    });
    return;
  }
  if (remainingPaid.length > 0) {
    await tx.tenantSubscription.update({
      where: { id: subscription.id },
      data: {
        ...(baseline.previous ? { planId: baseline.previous.planId } : {}),
        status: 'ACTIVE',
        graceUntil: null,
        canceledAt: null,
        currentPeriodEnd: periodEnd,
      },
    });
    return;
  }
  if (baseline.created) {
    await tx.tenantSubscription.update({
      where: { id: subscription.id },
      data: {
        status: 'CANCELED',
        canceledAt: input.now,
        currentPeriodEnd: periodEnd < input.now ? periodEnd : input.now,
      },
    });
    return;
  }
  const previous = baseline.previous;
  if (!previous) throw new Error('ENTITLEMENT_SNAPSHOT_INVALID');
  await tx.tenantSubscription.update({
    where: { id: subscription.id },
    data: {
      planId: previous.planId,
      status: previous.status,
      currentPeriodStart: new Date(previous.currentPeriodStart),
      currentPeriodEnd: new Date(previous.currentPeriodEnd),
      graceUntil: previous.graceUntil ? new Date(previous.graceUntil) : null,
      canceledAt: previous.canceledAt ? new Date(previous.canceledAt) : null,
    },
  });
}
