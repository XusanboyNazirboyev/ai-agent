'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { api, errorKey } from '@/lib/api';
import type { ConversationView } from '@/lib/types';

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
    onSuccess: () => setExternalId(''),
    onSettled: () =>
      void queryClient.invalidateQueries({
        queryKey: ['conversation', props.conversationId],
      }),
  });

  return (
    <section data-testid="actions-panel">
      <h3 className="font-semibold">{t('view.actions')}</h3>
      {props.actions.length === 0 ? <p>{t('view.noActions')}</p> : null}
      <ul className="flex flex-col gap-2">
        {props.actions.map((action) => (
          <li
            key={action.id}
            data-testid="action-item"
            data-status={action.status}
            className="rounded border border-slate-200 p-2 dark:border-slate-700"
          >
            <p className="font-medium">{t(`actionStatus.${action.status}`)}</p>
            <p className="text-xs text-slate-600 dark:text-slate-400">
              {formatDateTime(action.createdAt, props.timeZone)}
            </p>
            {action.externalId ? (
              <p className="text-xs">
                {t('view.actionReference', { id: action.externalId })}
              </p>
            ) : null}
            {action.status === 'UNCERTAIN' ? (
              <div className="mt-2 flex flex-col gap-2">
                {action.payload ? (
                  <ul className="text-xs">
                    {Object.entries(action.payload).map(([name, value]) => (
                      <li key={name}>
                        {name}: {value}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {props.canResolve ? (
                  <>
                    <p className="text-xs">{t('action.resolveIntro')}</p>
                    <label className="flex flex-col gap-1 text-xs">
                      {t('action.externalId')}
                      <input
                        value={externalId}
                        maxLength={200}
                        onChange={(e) => setExternalId(e.target.value)}
                        className="rounded border border-slate-300 bg-white px-2 py-1 text-slate-900 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
                      />
                    </label>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={resolve.isPending}
                        onClick={() =>
                          resolve.mutate({
                            id: action.id,
                            outcome: 'SUCCEEDED',
                          })
                        }
                        className="rounded bg-indigo-700 px-3 py-1 text-white disabled:opacity-60"
                      >
                        {t('action.markSucceeded')}
                      </button>
                      <button
                        type="button"
                        disabled={resolve.isPending}
                        onClick={() =>
                          resolve.mutate({ id: action.id, outcome: 'FAILED' })
                        }
                        className="rounded border border-slate-400 px-3 py-1 disabled:opacity-60"
                      >
                        {t('action.markFailed')}
                      </button>
                    </div>
                    {error ? (
                      <p
                        role="alert"
                        className="text-xs text-red-700 dark:text-red-400"
                      >
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
    </section>
  );
}
