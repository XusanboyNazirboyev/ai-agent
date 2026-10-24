'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { api, errorKey } from '@/lib/api';
import type { ActionStatus, ConversationView } from '@/lib/types';
import { Badge, type Tone } from './ui/badge';
import { Button } from './ui/button';
import { fieldClass } from './ui/fields';
import { Icon } from './ui/icons';
import { Section } from './ui/section';
import { useToast } from './ui/toast';

const STATUS_TONE: Record<ActionStatus, Tone> = {
  PROPOSED: 'accent',
  CONFIRMED: 'accent',
  DECLINED: 'neutral',
  SUPERSEDED: 'neutral',
  EXPIRED: 'neutral',
  CANCELLED: 'neutral',
  SUCCEEDED: 'success',
  FAILED: 'danger',
  UNCERTAIN: 'warning',
};

/**
 * Business actions of the conversation (ADR 024). An UNCERTAIN action shows
 * the values that were confirmed so a person can check the connected system,
 * then record what they found.
 */
export function ActionsPanel(props: {
  conversationId: string;
  actions: ConversationView['actions'];
  canResolve: boolean;
  timeZone?: string;
}): ReactNode {
  const { t, formatDateTime } = useI18n();
  const queryClient = useQueryClient();
  const notify = useToast();
  const [externalId, setExternalId] = useState('');
  const [error, setError] = useState<string | undefined>();
  const resolve = useMutation({
    mutationFn: (input: { id: string; outcome: 'SUCCEEDED' | 'FAILED' }) =>
      api(`/api/v1/inbox/actions/${input.id}/resolve`, {
        method: 'POST',
        body: {
          outcome: input.outcome,
          ...(input.outcome === 'SUCCEEDED' && externalId.trim()
            ? { externalId: externalId.trim() }
            : {}),
        },
      }),
    onMutate: () => setError(undefined),
    onError: (failure) => setError(errorKey(failure)),
    onSuccess: () => {
      setExternalId('');
      notify(t('toast.actionResolved'));
    },
    onSettled: () =>
      void queryClient.invalidateQueries({
        queryKey: ['conversation', props.conversationId],
      }),
  });

  return (
    <Section title={t('view.actions')} icon="bolt" testId="actions-panel">
      {props.actions.length === 0 ? (
        <p className="text-muted">{t('view.noActions')}</p>
      ) : null}
      <ul className="flex flex-col gap-2">
        {props.actions.map((action) => (
          <li
            key={action.id}
            data-testid="action-item"
            data-status={action.status}
            className="flex flex-col gap-1.5 rounded-lg border border-line p-2"
          >
            <span className="flex flex-wrap items-center justify-between gap-2">
              <Badge tone={STATUS_TONE[action.status]} dot>
                {t(`actionStatus.${action.status}`)}
              </Badge>
              <span className="text-xs text-muted">
                {formatDateTime(action.createdAt, props.timeZone)}
              </span>
            </span>
            {action.externalId ? (
              <p className="text-xs">
                {t('view.actionReference', { id: action.externalId })}
              </p>
            ) : null}
            {action.status === 'UNCERTAIN' ? (
              <div className="mt-1 flex flex-col gap-2">
                {action.payload ? (
                  <ul className="rounded-lg bg-surface-2 p-2 text-xs">
                    {Object.entries(action.payload).map(([name, value]) => (
                      <li key={name} className="break-words">
                        {name}: {value}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {props.canResolve ? (
                  <>
                    <p className="text-xs text-muted">
                      {t('action.resolveIntro')}
                    </p>
                    <label className="flex flex-col gap-1 text-xs font-medium">
                      {t('action.externalId')}
                      <input
                        value={externalId}
                        maxLength={200}
                        onChange={(e) => setExternalId(e.target.value)}
                        className={`${fieldClass} min-h-10 text-sm`}
                      />
                    </label>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="primary"
                        icon="check"
                        loading={resolve.isPending}
                        onClick={() =>
                          resolve.mutate({
                            id: action.id,
                            outcome: 'SUCCEEDED',
                          })
                        }
                      >
                        {t('action.markSucceeded')}
                      </Button>
                      <Button
                        size="sm"
                        icon="x"
                        disabled={resolve.isPending}
                        onClick={() =>
                          resolve.mutate({ id: action.id, outcome: 'FAILED' })
                        }
                      >
                        {t('action.markFailed')}
                      </Button>
                    </div>
                    {error ? (
                      <p
                        role="alert"
                        className="flex items-start gap-1.5 rounded-lg bg-danger-soft px-2 py-1.5 text-xs text-danger-fg"
                      >
                        <Icon
                          name="alert"
                          className="mt-0.5 h-3 w-3 shrink-0"
                        />
                        {t(error)}
                      </p>
                    ) : null}
                  </>
                ) : null}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </Section>
  );
}
