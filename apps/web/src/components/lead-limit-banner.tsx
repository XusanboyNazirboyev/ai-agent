'use client';

import type { ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { leadLimitNotice } from '@/lib/public-site';
import { Icon } from './ui/icons';

/** ADR 080: new leads this month against the plan; OWNER/ADMIN only (the API sends it only to them). */
export function LeadLimitBanner(props: {
  info:
    { newLeadsThisMonth: number; monthlyNewLeads: number } | null | undefined;
}): ReactNode {
  const { t } = useI18n();
  const notice = leadLimitNotice(props.info);
  if (!props.info || !notice) return null;
  return (
    <div
      role="status"
      data-testid="lead-limit-banner"
      data-state={notice}
      className="flex shrink-0 items-start gap-2 bg-warning-soft px-4 py-2 text-sm font-medium text-warning-fg"
    >
      <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
      <span>
        {t(
          notice === 'reached'
            ? 'banner.leadLimit.reached'
            : 'banner.leadLimit.near',
          {
            count: props.info.newLeadsThisMonth,
            limit: props.info.monthlyNewLeads,
          },
        )}
      </span>
    </div>
  );
}
