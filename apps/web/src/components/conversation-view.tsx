'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { api, errorKey } from '@/lib/api';
import { factLines } from '@/lib/facts';
import { markSeen } from '@/lib/seen';
import { ActionsPanel } from './actions-panel';
import type { ConversationView, LeadStatus, Role } from '@/lib/types';

const CANNED = ['greeting', 'wait', 'details', 'thanks', 'bye'];
const LEAD_STATUSES: LeadStatus[] = ['NEW', 'IN_PROGRESS', 'WON', 'LOST'];
const OPERATING: Role[] = ['OWNER', 'ADMIN', 'OPERATOR'];

type Action =
  'take-over' | 'return-to-bot' | 'close' | 'reply' | 'notes' | 'lead-status';

export function ConversationViewPane(props: {
  id: string;
  me: { id: string; role: Role };
  timeZone?: string;
  onBack: () => void;
}): ReactNode {
  const { t, formatDateTime } = useI18n();
  const queryClient = useQueryClient();
  const [reply, setReply] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | undefined>();

  const query = useQuery({
    queryKey: ['conversation', props.id],
    queryFn: () =>
      api<ConversationView>(`/api/v1/inbox/conversations/${props.id}`),
  });
  const view = query.data;

  useEffect(() => {
    setError(undefined);
    setReply('');
    setNote('');
  }, [props.id]);
  useEffect(() => {
    if (view) markSeen(props.id, new Date().toISOString());
  }, [props.id, view?.messages.length, view?.conversation.state]);

  const handoverId = view?.handover?.id;
  const command = useMutation({
    mutationFn: (input: { action: Action; body?: unknown }) =>
      api(`/api/v1/handovers/${handoverId}/${input.action}`, {
        method: 'POST',
        body: input.body,
        command: true,
      }),
    onMutate: () => setError(undefined),
    onError: (failure) => setError(errorKey(failure)),
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: ['conversation', props.id],
      });
      void queryClient.invalidateQueries({ queryKey: ['conversations'] });
    },
  });

  if (query.isPending) return <p className="p-6">{t('app.loading')}</p>;
  if (query.isError || !view)
    return (
      <div className="p-6">
        <p role="alert">{t(errorKey(query.error))}</p>
        <button
          type="button"
          className="underline"
          onClick={() => void query.refetch()}
        >
          {t('app.retry')}
        </button>
      </div>
    );

  const operating = OPERATING.includes(props.me.role);
  const state = view.conversation.state;
  const mine = view.conversation.assignedOperatorId === props.me.id;
  const canTake = operating && state === 'WAITING_OPERATOR' && handoverId;
  const canAct = operating && state === 'OPERATOR_ACTIVE' && mine && handoverId;
  const busy = command.isPending;

  function send(event: FormEvent): void {
    event.preventDefault();
    const text = reply.trim();
    if (!text) return;
    command.mutate(
      { action: 'reply', body: { text } },
      { onSuccess: () => setReply('') },
    );
  }
  function addNote(event: FormEvent): void {
    event.preventDefault();
    const text = note.trim();
    if (!text) return;
    command.mutate(
      { action: 'notes', body: { text } },
      { onSuccess: () => setNote('') },
    );
  }
  const summaryLines = factLines(view.handover?.summary);

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-testid="conversation-view"
    >
      <div className="flex items-center gap-3 border-b border-slate-200 px-4 py-2 dark:border-slate-700">
        <button
          type="button"
          className="underline md:hidden"
          onClick={props.onBack}
        >
          {t('view.back')}
        </button>
        <h2 className="font-semibold">
          {view.contact.name ?? t('list.unnamed')}
        </h2>
        <span
          data-testid="state"
          data-state={state}
          className="rounded bg-slate-100 px-2 py-0.5 text-sm dark:bg-slate-800"
        >
          {t(`state.${state}`)}
        </span>
        {state === 'OPERATOR_ACTIVE' && !mine ? (
          <span className="text-sm text-amber-700 dark:text-amber-400">
            {t('view.assignedToOther')}
          </span>
        ) : null}
      </div>

      {error ? (
        <p
          role="alert"
          data-testid="action-error"
          className="bg-red-50 px-4 py-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-200"
        >
          {t(error)}
        </p>
      ) : null}

      <div className="grid min-h-0 flex-1 gap-0 overflow-y-auto lg:grid-cols-[1fr_18rem]">
        <section
          aria-label={t('view.timeline')}
          className="flex flex-col gap-2 p-4"
        >
          {view.messages.length === 0 ? (
            <p className="text-slate-600 dark:text-slate-400">
              {t('view.noMessages')}
            </p>
          ) : null}
          <ol className="flex flex-col gap-2" data-testid="timeline">
            {view.messages.map((message) => {
              const own = message.authorType !== 'CUSTOMER';
              const offers = view.shownOffers.filter(
                (offer) => offer.messageId === message.id,
              );
              const quotes = view.quotes.filter(
                (quote) => quote.shownInMessageId === message.id,
              );
              return (
                <li
                  key={message.id}
                  data-author={message.authorType}
                  className={`max-w-[85%] rounded-lg px-3 py-2 ${own ? 'self-end bg-indigo-100 dark:bg-indigo-950' : 'self-start bg-white dark:bg-slate-800'}`}
                >
                  <p className="text-xs text-slate-600 dark:text-slate-400">
                    {t(`author.${message.authorType}`)} ·{' '}
                    {formatDateTime(message.createdAt, props.timeZone)}
                  </p>
                  {/* Customer text is untrusted: plain text only, never HTML. */}
                  <p className="whitespace-pre-wrap break-words">
                    {message.text}
                  </p>
                  {offers.map((offer) => (
                    <div
                      key={offer.id}
                      className="mt-1 rounded border border-slate-300 p-2 text-sm dark:border-slate-600"
                    >
                      <p className="font-medium">{offer.offerRef}</p>
                      {factLines(offer.facts).map((line) => (
                        <p key={line}>{line}</p>
                      ))}
                    </div>
                  ))}
                  {quotes.map((quote) => (
                    <p key={quote.id} className="mt-1 text-sm">
                      {t('view.quote', {
                        id: quote.id.slice(0, 8),
                        amount: quote.amount,
                        currency: quote.currency,
                      })}
                      {quote.validUntil
                        ? ` · ${t('view.validUntil', { date: formatDateTime(quote.validUntil, props.timeZone) })}`
                        : ''}
                    </p>
                  ))}
                  {message.authorType === 'OPERATOR' ? (
                    <p className="text-xs text-slate-600 dark:text-slate-400">
                      {t(`delivery.${message.deliveryState}`)}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ol>
        </section>

        <aside className="flex flex-col gap-4 border-l border-slate-200 p-4 text-sm dark:border-slate-700">
          <section>
            <h3 className="font-semibold">{t('view.handover')}</h3>
            {view.handover ? (
              <>
                <p>{t('view.reason', { code: view.handover.reasonCode })}</p>
                {summaryLines.map((line) => (
                  <p key={line} className="text-slate-700 dark:text-slate-300">
                    {line}
                  </p>
                ))}
              </>
            ) : (
              <p>{t('view.noHandover')}</p>
            )}
          </section>
          <section>
            <h3 className="font-semibold">{t('view.contact')}</h3>
            <p>
              {view.contact.phone
                ? t('view.phone', { phone: view.contact.phone })
                : t('view.noPhone')}
            </p>
          </section>
          <section>
            <h3 className="font-semibold">{t('view.lead')}</h3>
            {view.lead ? (
              <>
                <p>{t(`score.${view.lead.score}`)}</p>
                <label className="flex flex-col gap-1">
                  {t('view.leadStatus')}
                  <select
                    value={view.lead.status}
                    disabled={!operating || busy || !handoverId}
                    onChange={(e) =>
                      command.mutate({
                        action: 'lead-status',
                        body: { status: e.target.value },
                      })
                    }
                    className="rounded border border-slate-300 bg-white px-2 py-1 text-slate-900 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
                  >
                    {LEAD_STATUSES.map((status) => (
                      <option key={status} value={status}>
                        {t(`leadStatus.${status}`)}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            ) : (
              <p>{t('view.noLead')}</p>
            )}
          </section>
          <ActionsPanel
            conversationId={props.id}
            actions={view.actions ?? []}
            canResolve={operating}
            timeZone={props.timeZone}
          />
          <section>
            <h3 className="font-semibold">{t('view.slots')}</h3>
            {factLines(view.slots).length === 0 ? (
              <p>{t('view.noSlots')}</p>
            ) : (
              factLines(view.slots).map((line) => <p key={line}>{line}</p>)
            )}
          </section>
          <section>
            <h3 className="font-semibold">{t('view.notes')}</h3>
            {view.notes.length === 0 ? <p>{t('view.noNotes')}</p> : null}
            <ul className="flex flex-col gap-1" data-testid="notes">
              {view.notes.map((entry) => (
                <li
                  key={entry.id}
                  className="whitespace-pre-wrap break-words rounded bg-amber-50 p-2 dark:bg-amber-950"
                >
                  {entry.text}
                </li>
              ))}
            </ul>
            {operating && handoverId ? (
              <form onSubmit={addNote} className="mt-2 flex flex-col gap-1">
                <textarea
                  aria-label={t('action.notePlaceholder')}
                  placeholder={t('action.notePlaceholder')}
                  value={note}
                  maxLength={4096}
                  onChange={(e) => setNote(e.target.value)}
                  className="rounded border border-slate-300 bg-white p-2 text-slate-900 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
                />
                <button
                  type="submit"
                  disabled={busy || !note.trim()}
                  className="rounded border border-slate-400 px-3 py-1 disabled:opacity-60"
                >
                  {t('action.addNote')}
                </button>
              </form>
            ) : null}
          </section>
        </aside>
      </div>

      <div className="flex flex-col gap-2 border-t border-slate-200 p-3 dark:border-slate-700">
        <div className="flex flex-wrap gap-2">
          {canTake ? (
            <button
              type="button"
              data-testid="take-over"
              disabled={busy}
              onClick={() => command.mutate({ action: 'take-over' })}
              className="rounded bg-indigo-700 px-4 py-2 font-medium text-white disabled:opacity-60"
            >
              {t('action.takeOver')}
            </button>
          ) : null}
          {canAct ? (
            <>
              <button
                type="button"
                data-testid="return-to-bot"
                disabled={busy}
                onClick={() => command.mutate({ action: 'return-to-bot' })}
                className="rounded border border-slate-400 px-4 py-2 disabled:opacity-60"
              >
                {t('action.returnToBot')}
              </button>
              <button
                type="button"
                data-testid="close"
                disabled={busy}
                onClick={() => command.mutate({ action: 'close' })}
                className="rounded border border-slate-400 px-4 py-2 disabled:opacity-60"
              >
                {t('action.close')}
              </button>
            </>
          ) : null}
        </div>
        {canAct ? (
          <form onSubmit={send} className="flex flex-col gap-2">
            <select
              aria-label={t('action.canned')}
              value=""
              onChange={(e) =>
                e.target.value &&
                setReply(
                  (prev) =>
                    `${prev}${prev ? '\n' : ''}${t(`canned.${e.target.value}`)}`,
                )
              }
              className="rounded border border-slate-300 bg-white px-2 py-1 text-sm text-slate-900 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
            >
              <option value="">{t('action.cannedNone')}</option>
              {CANNED.map((id) => (
                <option key={id} value={id}>
                  {t(`canned.${id}`)}
                </option>
              ))}
            </select>
            <textarea
              data-testid="reply-input"
              aria-label={t('action.replyPlaceholder')}
              placeholder={t('action.replyPlaceholder')}
              value={reply}
              maxLength={4096}
              onChange={(e) => setReply(e.target.value)}
              className="min-h-20 rounded border border-slate-300 bg-white p-2 text-slate-900 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
            />
            <button
              type="submit"
              data-testid="send-reply"
              disabled={busy || !reply.trim()}
              className="self-end rounded bg-indigo-700 px-4 py-2 font-medium text-white disabled:opacity-60"
            >
              {busy ? t('action.sending') : t('action.reply')}
            </button>
          </form>
        ) : null}
      </div>
    </div>
  );
}
