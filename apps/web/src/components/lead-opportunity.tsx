'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { api, errorKey } from '@/lib/api';
import {
  CURRENCIES,
  formatAmount,
  isValidAmount,
  readLastCurrency,
  rememberLastCurrency,
} from '@/lib/currencies';
import type { LeadPipelineItem, TeamMember } from '@/lib/types';
import { useShell } from './app-shell';
import { Button } from './ui/button';
import { fieldClass } from './ui/fields';
import { FormDialog } from './ui/form-dialog';
import { Select } from './ui/select';
import { useToast } from './ui/toast';

const MAX_SOURCE = 60;
const MAX_LOST_REASON = 200;

function initials(name: string | null | undefined): string {
  if (!name) return '?';
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? '')
      .join('') || '?'
  );
}

export function LeadOpportunity(props: {
  leadId: string;
  item: LeadPipelineItem;
  role?: string;
  canEdit?: boolean;
  onChange?: () => void;
}): ReactNode {
  const { t } = useI18n();
  const { operator } = useShell();
  const qc = useQueryClient();
  const toast = useToast();
  const role = props.role ?? operator.role;
  const canEdit =
    props.canEdit ?? ['OWNER', 'ADMIN', 'OPERATOR'].includes(role);
  const isManager = role === 'OWNER' || role === 'ADMIN';
  const isViewer = role === 'VIEWER';
  const isOperator = role === 'OPERATOR';

  const [ownerId, setOwnerId] = useState(props.item.ownerOperatorId ?? '');
  const [amount, setAmount] = useState(props.item.amount ?? '');
  const [currency, setCurrency] = useState(
    props.item.currency ?? readLastCurrency() ?? 'UZS',
  );
  const [amountError, setAmountError] = useState<string | null>(null);
  const [source, setSource] = useState(props.item.source ?? '');
  const [closeDate, setCloseDate] = useState(
    props.item.expectedCloseDate ?? '',
  );
  const [lostReason, setLostReason] = useState(props.item.lostReason ?? '');
  const [lostOpen, setLostOpen] = useState(false);
  const [lostDraft, setLostDraft] = useState('');

  useEffect(() => {
    setOwnerId(props.item.ownerOperatorId ?? '');
    setAmount(props.item.amount ?? '');
    setCurrency(props.item.currency ?? readLastCurrency() ?? 'UZS');
    setSource(props.item.source ?? '');
    setCloseDate(props.item.expectedCloseDate ?? '');
    setLostReason(props.item.lostReason ?? '');
  }, [props.item]);

  const team = useQuery({
    queryKey: ['team'],
    queryFn: () => api<{ operators: TeamMember[] }>('/api/v1/team'),
    enabled: isManager,
  });
  const operators = (team.data?.operators ?? []).filter((o) => o.isActive);

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api(`/api/v1/leads/${props.item.id}/opportunity`, {
        method: 'PATCH',
        body,
      }),
    onSuccess: () => {
      toast(t('toast.opportunitySaved'));
      void qc.invalidateQueries({ queryKey: ['leads'] });
      void qc.invalidateQueries({ queryKey: ['conversation'] });
      props.onChange?.();
    },
  });

  const saveAmount = (): void => {
    setAmountError(null);
    const amt = amount.trim();
    if (amt === '') {
      save.mutate({ amount: null, currency: null });
      return;
    }
    if (!isValidAmount(amt)) {
      setAmountError(t('opportunity.amountInvalid'));
      return;
    }
    rememberLastCurrency(currency);
    save.mutate({ amount: amt, currency });
  };

  const saveSource = (): void => {
    const value = source.trim().slice(0, MAX_SOURCE);
    save.mutate({ source: value === '' ? null : value });
  };

  const saveClose = (): void => {
    save.mutate({ expectedCloseDate: closeDate === '' ? null : closeDate });
  };

  const changeOwner = (value: string): void => {
    setOwnerId(value);
    save.mutate({ ownerOperatorId: value === '' ? null : value });
  };

  const assignMe = (): void => {
    if (!isOperator) return;
    save.mutate({ ownerOperatorId: operator.id });
  };

  const lost = props.item.status === 'LOST';
  const ownerName = props.item.owner?.displayName ?? null;
  const amountText = formatAmount(props.item.amount, props.item.currency);
  const ownerSelect =
    isManager && !isViewer ? (
      <label className="flex min-w-0 flex-1 basis-44 flex-col gap-1 text-xs text-muted">
        {t('opportunity.owner')}
        <select
          value={ownerId}
          onChange={(e) => changeOwner(e.target.value)}
          disabled={save.isPending}
          className="min-h-9 rounded-lg border border-line bg-surface px-2 text-sm text-fg"
          aria-label={t('opportunity.owner')}
        >
          <option value="">{t('opportunity.unassigned')}</option>
          {operators.map((o) => (
            <option key={o.id} value={o.id}>
              {o.displayName}
            </option>
          ))}
        </select>
      </label>
    ) : (
      <div className="flex min-w-0 flex-1 basis-44 flex-col gap-1 text-xs text-muted">
        <span>{t('opportunity.owner')}</span>
        <div className="flex items-center gap-2">
          <span className="text-sm text-fg">
            {ownerName ?? t('opportunity.unassigned')}
          </span>
          {isOperator && !isViewer ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={assignMe}
              disabled={save.isPending}
              data-testid="opportunity-assign-me"
            >
              {t('opportunity.assignMe')}
            </Button>
          ) : null}
        </div>
      </div>
    );

  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="lead-opportunity">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        {ownerName ? (
          <span
            className="flex items-center gap-1.5"
            data-testid="lead-owner-summary"
          >
            <span className="grid h-6 w-6 place-items-center rounded-full bg-surface-2 text-[10px] font-semibold">
              {initials(ownerName)}
            </span>
            <span className="truncate">{ownerName}</span>
          </span>
        ) : (
          <span data-testid="lead-owner-summary">
            {t('opportunity.unassigned')}
          </span>
        )}
        {amountText !== '—' ? (
          <span data-testid="lead-amount-summary">{amountText}</span>
        ) : null}
        {props.item.expectedCloseDate ? (
          <span data-testid="lead-close-summary">
            {props.item.expectedCloseDate}
          </span>
        ) : null}
      </div>
      {canEdit || isViewer ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {ownerSelect}
          <div className="flex min-w-0 flex-1 basis-44 flex-col gap-1 text-xs text-muted">
            <span>{t('opportunity.amount')}</span>
            <div className="flex items-center gap-2">
              <input
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                disabled={!canEdit || isViewer || save.isPending}
                className={`${fieldClass} min-w-0 flex-1`}
                aria-label={t('opportunity.amount')}
                data-testid="opportunity-amount"
              />
              <select
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
                disabled={!canEdit || isViewer || save.isPending}
                className="min-h-9 rounded-lg border border-line bg-surface px-2 text-sm text-fg"
                aria-label={t('opportunity.currency')}
                data-testid="opportunity-currency"
              >
                {CURRENCIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              {canEdit && !isViewer ? (
                <Button
                  size="sm"
                  onClick={saveAmount}
                  disabled={save.isPending}
                  data-testid="opportunity-save-amount"
                >
                  {t('app.save')}
                </Button>
              ) : null}
            </div>
            {amountError ? (
              <p role="alert" className="text-xs text-danger-fg">
                {amountError}
              </p>
            ) : null}
          </div>
          <div className="flex min-w-0 flex-1 basis-44 flex-col gap-1 text-xs text-muted">
            <span>{t('opportunity.source')}</span>
            <div className="flex items-center gap-2">
              <input
                value={source}
                onChange={(e) => setSource(e.target.value)}
                disabled={!canEdit || isViewer || save.isPending}
                maxLength={MAX_SOURCE}
                className={`${fieldClass} min-w-0 flex-1`}
                aria-label={t('opportunity.source')}
                data-testid="opportunity-source"
              />
              {canEdit && !isViewer ? (
                <Button
                  size="sm"
                  onClick={saveSource}
                  disabled={save.isPending}
                  data-testid="opportunity-save-source"
                >
                  {t('app.save')}
                </Button>
              ) : null}
            </div>
          </div>
          <div className="flex min-w-0 flex-1 basis-44 flex-col gap-1 text-xs text-muted">
            <span>{t('opportunity.closeDate')}</span>
            <div className="flex items-center gap-2">
              <input
                type="date"
                value={closeDate}
                onChange={(e) => setCloseDate(e.target.value)}
                disabled={!canEdit || isViewer || save.isPending}
                className={`${fieldClass} min-w-0 flex-1`}
                aria-label={t('opportunity.closeDate')}
                data-testid="opportunity-close-date"
              />
              {canEdit && !isViewer ? (
                <Button
                  size="sm"
                  onClick={saveClose}
                  disabled={save.isPending}
                  data-testid="opportunity-save-close"
                >
                  {t('app.save')}
                </Button>
              ) : null}
            </div>
          </div>
          {lost ? (
            <div className="flex min-w-0 flex-1 basis-44 flex-col gap-1 text-xs text-muted sm:col-span-2">
              <span>{t('opportunity.lostReason')}</span>
              <div className="flex items-center gap-2">
                <input
                  value={lostReason}
                  onChange={(e) => setLostReason(e.target.value)}
                  disabled={!canEdit || isViewer || save.isPending}
                  maxLength={MAX_LOST_REASON}
                  className={`${fieldClass} min-w-0 flex-1`}
                  aria-label={t('opportunity.lostReason')}
                  data-testid="opportunity-lost-reason"
                />
                {canEdit && !isViewer ? (
                  <Button
                    size="sm"
                    onClick={() =>
                      save.mutate({ lostReason: lostReason.trim() || null })
                    }
                    disabled={save.isPending}
                    data-testid="opportunity-save-lost"
                  >
                    {t('app.save')}
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
      {save.isError ? (
        <p role="alert" className="text-xs text-danger-fg">
          {t(errorKey(save.error))}
        </p>
      ) : null}
      <FormDialog
        open={lostOpen}
        title={t('opportunity.lostReason')}
        description={t('opportunity.lostReasonBody')}
        testId="lost-reason-dialog"
        onClose={() => setLostOpen(false)}
        onSubmit={() => {
          const value = lostDraft.trim();
          if (value === '') return;
          setLostReason(value);
          save.mutate(
            { lostReason: value },
            { onSuccess: () => setLostOpen(false) },
          );
        }}
        footer={
          <>
            <Button variant="secondary" onClick={() => setLostOpen(false)}>
              {t('app.cancel')}
            </Button>
            <Button type="submit" variant="primary" loading={save.isPending}>
              {t('app.save')}
            </Button>
          </>
        }
      >
        <label className="flex flex-col gap-1 text-sm font-medium">
          {t('opportunity.lostReason')}
          <input
            value={lostDraft}
            onChange={(e) => setLostDraft(e.target.value)}
            maxLength={MAX_LOST_REASON}
            className={fieldClass}
            autoFocus
            aria-label={t('opportunity.lostReason')}
          />
        </label>
      </FormDialog>
    </div>
  );
}
