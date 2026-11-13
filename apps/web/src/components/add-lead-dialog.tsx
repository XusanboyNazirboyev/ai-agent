'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { api, errorKey } from '@/lib/api';
import {
  CURRENCIES,
  parseAmount,
  readLastCurrency,
  rememberLastCurrency,
} from '@/lib/currencies';
import type { BoardStageView, LeadPipelineItem, TeamMember } from '@/lib/types';
import { useShell } from './app-shell';
import { stageLabel } from './lead-board-utils';
import { Button } from './ui/button';
import { fieldClass } from './ui/fields';
import { FormDialog } from './ui/form-dialog';
import { useToast } from './ui/toast';

/**
 * Adds a lead by hand (ADR 061): a phone call, a walk-in, a referral. The
 * stage is preselected from the column whose "+" opened the dialog; closed
 * (WON/LOST) stages are not offered, a lead is never created closed.
 */
export function AddLeadDialog(props: {
  open: boolean;
  pipelineId: string;
  stages: BoardStageView[];
  /** The stage to preselect (a column "+"), else the first open stage. */
  stageId: string | null;
  onClose: () => void;
}): ReactNode {
  const { t } = useI18n();
  const { operator } = useShell();
  const qc = useQueryClient();
  const toast = useToast();
  const isManager = operator.role === 'OWNER' || operator.role === 'ADMIN';
  const openStages = props.stages.filter((s) => s.kind === 'OPEN');

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [stageId, setStageId] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState<string>('UZS');
  const [source, setSource] = useState('');
  const [ownerId, setOwnerId] = useState('');
  const [note, setNote] = useState('');

  // Each opening starts from a clean form on the chosen stage.
  useEffect(() => {
    if (!props.open) return;
    setName('');
    setPhone('');
    setAmount('');
    setCurrency(readLastCurrency() ?? 'UZS');
    setSource('');
    setOwnerId(operator.id);
    setNote('');
    const wanted = openStages.find((s) => s.id === props.stageId);
    setStageId((wanted ?? openStages[0])?.id ?? '');
    // openStages derives from props.stages; the form resets only on opening.
  }, [props.open, props.stageId]);

  // The board may still be loading when the dialog opens: take the first open
  // stage as soon as the stages arrive, or the form could never be submitted.
  const firstOpenId = openStages[0]?.id ?? '';
  useEffect(() => {
    if (props.open && stageId === '' && firstOpenId !== '')
      setStageId(firstOpenId);
  }, [props.open, stageId, firstOpenId]);

  const team = useQuery({
    queryKey: ['team'],
    queryFn: () => api<{ operators: TeamMember[] }>('/api/v1/team'),
    enabled: isManager && props.open,
  });
  const operators = (team.data?.operators ?? []).filter((o) => o.isActive);

  const amountText = amount.trim();
  const amountOk = amountText === '' || parseAmount(amountText) !== null;
  const canSubmit = name.trim() !== '' && stageId !== '' && amountOk;

  const create = useMutation({
    mutationFn: () =>
      api<LeadPipelineItem>('/api/v1/leads', {
        method: 'POST',
        body: {
          name: name.trim(),
          pipelineId: props.pipelineId,
          stageId,
          ...(phone.trim() ? { phone: phone.trim() } : {}),
          ...(amountText ? { amount: amountText, currency } : {}),
          ...(source.trim() ? { source: source.trim() } : {}),
          ...(ownerId ? { ownerOperatorId: ownerId } : {}),
          ...(note.trim() ? { note: note.trim() } : {}),
        },
      }),
    onSuccess: () => {
      if (amountText) rememberLastCurrency(currency);
      toast(t('toast.leadAdded'));
      void qc.invalidateQueries({ queryKey: ['board'] });
      void qc.invalidateQueries({ queryKey: ['leads'] });
      void qc.invalidateQueries({ queryKey: ['pipelines'] });
      props.onClose();
    },
  });

  return (
    <FormDialog
      open={props.open}
      title={t('leads.add.title')}
      description={t('leads.add.description')}
      testId="lead-add-dialog"
      onClose={props.onClose}
      onSubmit={() => {
        if (canSubmit && !create.isPending) create.mutate();
      }}
      footer={
        <>
          <Button variant="secondary" onClick={props.onClose}>
            {t('app.cancel')}
          </Button>
          <Button
            type="submit"
            variant="primary"
            loading={create.isPending}
            disabled={!canSubmit}
            data-testid="lead-add-submit"
          >
            {t('leads.add.submit')}
          </Button>
        </>
      }
    >
      <div className="flex min-w-0 flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm font-medium">
          {t('leads.add.name')}
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={200}
            required
            autoFocus
            className={fieldClass}
            data-testid="lead-add-name"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          {t('leads.add.phone')}
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            type="tel"
            inputMode="tel"
            maxLength={60}
            className={fieldClass}
            data-testid="lead-add-phone"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          {t('leads.add.stage')}
          <select
            value={stageId}
            onChange={(e) => setStageId(e.target.value)}
            className={fieldClass}
            data-testid="lead-add-stage"
          >
            {openStages.map((s) => (
              <option key={s.id} value={s.id}>
                {stageLabel(s, t)}
              </option>
            ))}
          </select>
        </label>
        <div className="flex min-w-0 flex-wrap items-end gap-2">
          <label className="flex min-w-0 flex-1 basis-32 flex-col gap-1 text-sm font-medium">
            {t('opportunity.amount')}
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              maxLength={15}
              aria-invalid={!amountOk}
              className={fieldClass}
              data-testid="lead-add-amount"
            />
          </label>
          <label className="flex min-w-0 basis-24 flex-col gap-1 text-sm font-medium">
            {t('opportunity.currency')}
            <select
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
              className={fieldClass}
              data-testid="lead-add-currency"
            >
              {CURRENCIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="flex flex-col gap-1 text-sm font-medium">
          {t('opportunity.source')}
          <input
            value={source}
            onChange={(e) => setSource(e.target.value)}
            maxLength={60}
            placeholder={t('leads.add.sourcePlaceholder')}
            className={fieldClass}
            data-testid="lead-add-source"
          />
        </label>
        {isManager ? (
          <label className="flex flex-col gap-1 text-sm font-medium">
            {t('opportunity.owner')}
            <select
              value={ownerId}
              onChange={(e) => setOwnerId(e.target.value)}
              className={fieldClass}
              data-testid="lead-add-owner"
            >
              {operators.length === 0 ? (
                <option value={operator.id}>{operator.displayName}</option>
              ) : null}
              {operators.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.displayName}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="flex flex-col gap-1 text-sm font-medium">
          {t('leads.add.note')}
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={1000}
            rows={3}
            className={fieldClass}
            data-testid="lead-add-note"
          />
        </label>
        {create.isError ? (
          <p role="alert" className="text-sm text-danger-fg">
            {t(errorKey(create.error))}
          </p>
        ) : null}
      </div>
    </FormDialog>
  );
}
