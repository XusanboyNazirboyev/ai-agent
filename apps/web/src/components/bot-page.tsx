'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { api, errorKey } from '@/lib/api';
import type { AgentMode, ChannelAccount } from '@/lib/types';
import { useShell } from './app-shell';
import { Badge, type Tone } from './ui/badge';
import { Button } from './ui/button';
import { ConfirmDialog } from './ui/confirm-dialog';
import { Icon } from './ui/icons';
import { SkeletonRows } from './ui/skeleton';
import { useToast } from './ui/toast';

const MODES: AgentMode[] = ['OFF', 'SHADOW', 'LIVE'];
const MODE_TONE: Record<AgentMode, Tone> = {
  OFF: 'neutral',
  SHADOW: 'warning',
  LIVE: 'success',
};

/** Product names are not translated. */
const NAMES: Record<string, string> = { telegram: 'Telegram' };

/** Switches the assistant Off / Drafts only / On for each messenger account. */
export function BotPage(): ReactNode {
  const { t } = useI18n();
  const { operator } = useShell();
  const toast = useToast();
  const queryClient = useQueryClient();
  const canChange = operator.role === 'OWNER' || operator.role === 'ADMIN';
  const [pendingLive, setPendingLive] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ['channels'],
    queryFn: () => api<{ items: ChannelAccount[] }>('/api/v1/channels'),
  });
  const change = useMutation({
    mutationFn: (input: { id: string; mode: AgentMode }) =>
      api<ChannelAccount>(`/api/v1/channels/${input.id}/agent-mode`, {
        method: 'PUT',
        body: { mode: input.mode },
      }),
    onSuccess: () => {
      toast(t('toast.botMode'));
      void queryClient.invalidateQueries({ queryKey: ['channels'] });
    },
    onSettled: () => setPendingLive(null),
  });

  function choose(account: ChannelAccount, mode: AgentMode): void {
    if (mode === account.agentMode) return;
    if (mode === 'LIVE') setPendingLive(account.id);
    else change.mutate({ id: account.id, mode });
  }

  const items = query.data?.items ?? [];
  return (
    <div
      role="region"
      tabIndex={0}
      aria-label={t('nav.bot')}
      className="min-h-0 flex-1 overflow-y-auto"
    >
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-3 sm:p-6">
        <p className="text-sm text-muted">{t('bot.intro')}</p>
        {!canChange ? (
          <p className="flex items-start gap-2 rounded-xl bg-surface-2 p-3 text-sm text-muted">
            <Icon name="info" className="mt-0.5 h-4 w-4 shrink-0" />
            {t('bot.readOnly')}
          </p>
        ) : null}
        {change.isError ? (
          <p
            role="alert"
            data-testid="bot-error"
            className="flex items-center gap-2 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger-fg"
          >
            <Icon name="alert" />
            {t(errorKey(change.error))}
          </p>
        ) : null}
        {query.isPending ? (
          <div
            role="status"
            className="overflow-hidden rounded-2xl border border-line bg-surface"
          >
            <span className="sr-only">{t('app.loading')}</span>
            <SkeletonRows rows={2} />
          </div>
        ) : null}
        {query.isError ? (
          <div className="flex flex-col items-start gap-3">
            <p
              role="alert"
              className="flex items-center gap-2 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger-fg"
            >
              <Icon name="alert" />
              {t(errorKey(query.error))}
            </p>
            <Button size="sm" onClick={() => void query.refetch()}>
              {t('app.retry')}
            </Button>
          </div>
        ) : null}
        {query.isSuccess && items.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-line bg-surface p-6 text-center text-sm text-muted">
            {t('bot.empty')}
          </p>
        ) : null}

        {items.map((account, index) => (
          <section
            key={account.id}
            data-testid="bot-account"
            aria-labelledby={`bot-${account.id}`}
            className="flex min-w-0 flex-col gap-4 rounded-2xl border border-line bg-surface p-4 shadow-card sm:p-5"
          >
            <header className="flex flex-wrap items-center justify-between gap-2">
              <h2
                id={`bot-${account.id}`}
                className="flex min-w-0 items-center gap-2 font-semibold"
              >
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-primary-soft text-primary-fg">
                  <Icon name="bot" className="h-5 w-5" />
                </span>
                <span className="truncate">
                  {t('bot.account', {
                    name: NAMES[account.channelType] ?? account.channelType,
                    number: index + 1,
                  })}
                </span>
              </h2>
              <span data-testid="bot-current" data-mode={account.agentMode}>
                <Badge tone={MODE_TONE[account.agentMode]} dot>
                  {t(`botMode.${account.agentMode}`)}
                </Badge>
              </span>
            </header>
            <div
              role="radiogroup"
              aria-label={t('bot.modeGroup')}
              className="grid grid-cols-1 gap-2 md:grid-cols-3"
            >
              {MODES.map((mode) => {
                const refusal = account.modeRefusals[mode];
                const selected = account.agentMode === mode;
                const disabled =
                  !canChange || Boolean(refusal) || change.isPending;
                return (
                  <label
                    key={mode}
                    className={`relative flex min-w-0 flex-col gap-1.5 rounded-xl border p-3 transition-colors ${
                      selected
                        ? 'border-primary bg-primary-soft'
                        : 'border-line bg-canvas'
                    } ${disabled && !selected ? 'opacity-70' : 'cursor-pointer hover:border-primary'}`}
                  >
                    <input
                      type="radio"
                      name={`mode-${account.id}`}
                      value={mode}
                      data-testid={`bot-mode-${mode}`}
                      checked={selected}
                      disabled={disabled}
                      onChange={() => choose(account, mode)}
                      className="peer sr-only"
                    />
                    <span className="pointer-events-none absolute inset-0 rounded-xl peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring" />
                    <span className="flex items-center justify-between gap-2 font-medium">
                      {t(`botMode.${mode}`)}
                      {selected ? (
                        <Icon
                          name="check"
                          className="h-4 w-4 shrink-0 text-primary-fg"
                        />
                      ) : null}
                    </span>
                    <span className="text-sm text-muted">
                      {t(`botModeDesc.${mode}`)}
                    </span>
                    {refusal ? (
                      <span className="text-xs text-warning-fg">
                        {t(`botRefusal.${refusal}`)}
                      </span>
                    ) : null}
                  </label>
                );
              })}
            </div>
          </section>
        ))}

        <section className="flex flex-col gap-2 rounded-2xl border border-line bg-surface p-4 sm:p-5">
          <h2 className="font-semibold">{t('bot.rulesTitle')}</h2>
          <ul className="flex flex-col gap-2 text-sm text-muted">
            {['bot.rule1', 'bot.rule2', 'bot.rule3'].map((key) => (
              <li key={key} className="flex items-start gap-2">
                <Icon
                  name="check"
                  className="mt-0.5 h-4 w-4 shrink-0 text-success-fg"
                />
                {t(key)}
              </li>
            ))}
          </ul>
        </section>
      </div>

      <ConfirmDialog
        open={pendingLive !== null}
        title={t('bot.confirmTitle')}
        body={t('bot.confirmBody')}
        confirmLabel={t('bot.confirmOn')}
        cancelLabel={t('confirm.cancel')}
        busy={change.isPending}
        onConfirm={() => {
          if (pendingLive) change.mutate({ id: pendingLive, mode: 'LIVE' });
        }}
        onCancel={() => setPendingLive(null)}
      />
    </div>
  );
}
