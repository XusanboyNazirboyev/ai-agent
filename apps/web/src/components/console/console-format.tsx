'use client';

import type { ReactNode } from 'react';
import { useI18n } from '@/i18n';
import type { TenantStatus } from '@/lib/platform-types';
import type { SubscriptionStatus } from '@/lib/types';
import { Badge, type Tone } from '../ui/badge';

const TENANT_TONE: Record<TenantStatus, Tone> = {
  ACTIVE: 'success',
  SUSPENDED: 'danger',
  ARCHIVED: 'neutral',
};

const SUBSCRIPTION_TONE: Record<SubscriptionStatus, Tone> = {
  TRIAL: 'accent',
  ACTIVE: 'success',
  PAST_DUE: 'warning',
  EXPIRED: 'danger',
  CANCELED: 'neutral',
};

export function TenantStatusBadge(props: { status: TenantStatus }): ReactNode {
  const { t } = useI18n();
  return (
    <Badge tone={TENANT_TONE[props.status]} dot>
      {t(`tenantStatus.${props.status}`)}
    </Badge>
  );
}

export function SubscriptionBadge(props: {
  status: SubscriptionStatus | null | undefined;
}): ReactNode {
  const { t } = useI18n();
  if (!props.status)
    return <Badge tone="neutral">{t('console.noSubscription')}</Badge>;
  return (
    <Badge tone={SUBSCRIPTION_TONE[props.status]} dot>
      {t(`subscriptionStatus.${props.status}`)}
    </Badge>
  );
}

/** A label/value pair inside a <dl>. */
export function Field(props: {
  label: string;
  children: ReactNode;
  testId?: string;
}): ReactNode {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-xs text-muted">{props.label}</dt>
      <dd
        data-testid={props.testId}
        className="min-w-0 text-sm font-medium break-words"
      >
        {props.children}
      </dd>
    </div>
  );
}

/** A titled card of a console page. */
export function Card(props: {
  title: string;
  actions?: ReactNode;
  testId?: string;
  children: ReactNode;
}): ReactNode {
  return (
    <section
      data-testid={props.testId}
      className="flex min-w-0 flex-col gap-4 rounded-2xl border border-line bg-surface p-4 shadow-card sm:p-5"
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">{props.title}</h2>
        {props.actions ? (
          <div className="flex flex-wrap gap-2">{props.actions}</div>
        ) : null}
      </header>
      {props.children}
    </section>
  );
}
