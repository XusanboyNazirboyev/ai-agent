'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { api, errorKey } from '@/lib/api';
import type { LeadPipelineItem, TeamMember } from '@/lib/types';
import { useShell } from './app-shell';
import { Avatar } from './ui/avatar';
import { Button } from './ui/button';
import { Select } from './ui/select';
import { useToast } from './ui/toast';

/**
 * The responsible operator of a lead, shown prominently. OWNER/ADMIN pick any
 * active operator; an OPERATOR can take the lead; a VIEWER only reads.
 */
export function LeadResponsible(props: { item: LeadPipelineItem }): ReactNode {
  const { t } = useI18n();
  const { operator } = useShell();
  const qc = useQueryClient();
  const toast = useToast();
  const { item } = props;
  const isManager = operator.role === 'OWNER' || operator.role === 'ADMIN';
  const isOperator = operator.role === 'OPERATOR';
  const team = useQuery({
    queryKey: ['team'],
    queryFn: () => api<{ operators: TeamMember[] }>('/api/v1/team'),
    enabled: isManager,
  });
  const save = useMutation({
    mutationFn: (ownerOperatorId: string | null) =>
      api(`/api/v1/leads/${item.id}/opportunity`, {
        method: 'PATCH',
        body: { ownerOperatorId },
      }),
    onSuccess: () => {
      toast(t('toast.opportunitySaved'));
      void qc.invalidateQueries({ queryKey: ['leads'] });
      void qc.invalidateQueries({ queryKey: ['lead-timeline'] });
    },
    onError: (e) => toast(t(errorKey(e))),
  });
  const name = item.owner?.displayName ?? null;
  const operators = (team.data?.operators ?? []).filter((o) => o.isActive);
  return (
    <section
      data-testid="lead-responsible"
      aria-label={t('leadPage.responsible')}
      className="flex flex-col gap-2 rounded-xl border border-line bg-surface p-3 shadow-card"
    >
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
        {t('leadPage.responsible')}
      </h3>
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        {name ? <Avatar name={name} size="sm" /> : null}
        <span
          data-testid="lead-responsible-name"
          className="min-w-0 flex-1 truncate text-sm font-medium"
        >
          {name ?? t('opportunity.unassigned')}
        </span>
        {isOperator && item.ownerOperatorId !== operator.id ? (
          <Button
            size="sm"
            variant="secondary"
            loading={save.isPending}
            data-testid="lead-responsible-assign-me"
            onClick={() => save.mutate(operator.id)}
          >
            {t('opportunity.assignMe')}
          </Button>
        ) : null}
      </div>
      {isManager ? (
        <Select
          compact
          value={item.ownerOperatorId ?? ''}
          disabled={save.isPending}
          aria-label={t('leadPage.responsible')}
          data-testid="lead-responsible-select"
          onChange={(e) => save.mutate(e.target.value || null)}
        >
          <option value="">{t('opportunity.unassigned')}</option>
          {operators.map((o) => (
            <option key={o.id} value={o.id}>
              {o.displayName}
            </option>
          ))}
        </Select>
      ) : null}
    </section>
  );
}
