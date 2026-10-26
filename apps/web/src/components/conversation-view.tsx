'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useI18n } from '@/i18n';
import { api, errorKey } from '@/lib/api';
import { factLines } from '@/lib/facts';
import { markSeen } from '@/lib/seen';
import type {
  ConversationView,
  LeadScore,
  LeadStatus,
  Role,
} from '@/lib/types';
import { useNow } from '@/lib/use-now';
import { ActionsPanel } from './actions-panel';
import { Avatar } from './ui/avatar';
import { Badge, type Tone } from './ui/badge';
import { Button } from './ui/button';
import { ConfirmDialog } from './ui/confirm-dialog';
import { textareaClass } from './ui/fields';
import { Select } from './ui/select';
import { Icon, type IconName } from './ui/icons';
import { Section } from './ui/section';
import { useToast } from './ui/toast';

const CANNED = ['greeting', 'wait', 'details', 'thanks', 'bye'];
const LEAD_STATUSES: LeadStatus[] = ['NEW', 'IN_PROGRESS', 'WON', 'LOST'];
const OPERATING: Role[] = ['OWNER', 'ADMIN', 'OPERATOR'];

type Action =
  'take-over' | 'return-to-bot' | 'close' | 'reply' | 'notes' | 'lead-status';

const TOAST: Record<Action, string> = {
  'take-over': 'toast.takeOver',
  'return-to-bot': 'toast.returnToBot',
  close: 'toast.close',
  reply: 'toast.reply',
  notes: 'toast.note',
  'lead-status': 'toast.leadStatus',
};

const SCORE_TONE: Record<LeadScore, Tone> = {
  HOT: 'danger',
  WARM: 'warning',
  COLD: 'neutral',
};

const AUTHOR_ICON: Record<string, IconName> = {
  CUSTOMER: 'user',
  BOT: 'bot',
  OPERATOR: 'headset',
  SYSTEM: 'info',
};

const BUBBLE: Record<string, string> = {
  CUSTOMER:
    'self-start rounded-2xl rounded-bl-md border border-line bg-surface text-fg',
  BOT: 'self-end rounded-2xl rounded-br-md border border-line bg-surface-2 text-fg',
  OPERATOR: 'self-end rounded-2xl rounded-br-md bg-primary text-white',
  SYSTEM: 'self-center rounded-full bg-surface-2 px-4 text-muted',
};

export function ConversationViewPane(props: {
  id: string;
  me: { id: string; role: Role };
  timeZone?: string;
  onBack: () => void;
}): ReactNode {
  const { t, formatDateTime } = useI18n();
  const queryClient = useQueryClient();
  const notify = useToast();
  const now = useNow();
  const [reply, setReply] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [showDetails, setShowDetails] = useState(false);
  const [confirm, setConfirm] = useState<'close' | 'return-to-bot' | null>(
    null,
  );
  const timelineRef = useRef<HTMLElement>(null);
  const stickToBottom = useRef(true);

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
    setShowDetails(false);
    setConfirm(null);
    stickToBottom.current = true;
  }, [props.id]);
  useEffect(() => {
    if (view) markSeen(props.id, new Date().toISOString());
  }, [props.id, view?.messages.length, view?.conversation.state]);
  useEffect(() => {
    const element = timelineRef.current;
    if (element && stickToBottom.current)
      element.scrollTop = element.scrollHeight;
  }, [view?.messages.length, props.id, showDetails]);

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
    onSuccess: (_data, input) => notify(t(TOAST[input.action])),
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: ['conversation', props.id],
      });
      void queryClient.invalidateQueries({ queryKey: ['conversations'] });
    },
  });

  if (query.isPending)
    return (
      <div
        className="flex flex-1 items-center justify-center gap-3 text-muted"
        role="status"
      >
        <span className="h-5 w-5 animate-spin rounded-full border-2 border-current border-t-transparent" />
        {t('app.loading')}
      </div>
    );
  if (query.isError || !view)
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
        <p
          role="alert"
          className="flex items-center gap-2 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger-fg"
        >
          <Icon name="alert" />
          {t(errorKey(query.error))}
        </p>
        <Button onClick={() => void query.refetch()}>{t('app.retry')}</Button>
      </div>
    );

  const operating = OPERATING.includes(props.me.role);
  const state = view.conversation.state;
  const mine = view.conversation.assignedOperatorId === props.me.id;
  const canTake = operating && state === 'WAITING_OPERATOR' && handoverId;
  const canAct = operating && state === 'OPERATOR_ACTIVE' && mine && handoverId;
  const busy = command.isPending;
  const notice = !operating
    ? t('view.readOnly')
    : state === 'CLOSED'
      ? t('view.closedNotice')
      : state === 'BOT_ACTIVE'
        ? t('view.noHandover')
        : state === 'OPERATOR_ACTIVE' && !mine
          ? t('view.assignedToOther')
          : null;

  function send(event?: FormEvent): void {
    event?.preventDefault();
    const text = reply.trim();
    if (!text || busy) return;
    command.mutate(
      { action: 'reply', body: { text } },
      { onSuccess: () => setReply('') },
    );
  }
  function onReplyKey(event: KeyboardEvent): void {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      send();
    }
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
  const slots = factLines(view.slots);
  const slaDue = view.handover?.slaDueAt ?? null;
  const slaOverdue = slaDue ? Date.parse(slaDue) < now : false;
  const name = view.contact.name ?? t('list.unnamed');

  return (
    <div
      className="flex min-h-0 flex-1 flex-col bg-canvas"
      data-testid="conversation-view"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-line bg-surface px-3 py-2 sm:gap-3 sm:px-4">
        <Button
          size="sm"
          variant="ghost"
          icon="chevronLeft"
          className="shrink-0 md:hidden"
          onClick={props.onBack}
        >
          <span className="sr-only">{t('view.back')}</span>
        </Button>
        <Avatar name={view.contact.name} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 className="truncate font-semibold">{name}</h2>
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span
              data-testid="state"
              data-state={state}
              className="max-w-full min-w-0"
            >
              <Badge
                className="max-w-full"
                tone={
                  state === 'WAITING_OPERATOR'
                    ? 'warning'
                    : state === 'OPERATOR_ACTIVE'
                      ? 'accent'
                      : 'neutral'
                }
                dot
              >
                {t(`state.${state}`)}
              </Badge>
            </span>
            {view.contact.phone ? (
              <span className="flex min-w-0 items-center gap-1 text-xs break-all text-muted">
                <Icon name="phone" className="h-3 w-3 shrink-0" />
                {view.contact.phone}
              </span>
            ) : null}
          </span>
        </div>
        <Button
          size="sm"
          variant={showDetails ? 'primary' : 'secondary'}
          icon="panel"
          className="shrink-0 xl:hidden"
          aria-expanded={showDetails}
          aria-controls="conversation-details"
          onClick={() => setShowDetails(!showDetails)}
        >
          <span className="sr-only sm:not-sr-only">
            {showDetails ? t('view.showConversation') : t('view.showDetails')}
          </span>
        </Button>
      </div>

      {error ? (
        <p
          role="alert"
          data-testid="action-error"
          className="flex shrink-0 items-center gap-2 bg-danger-soft px-4 py-2 text-sm text-danger-fg"
        >
          <Icon name="alert" />
          {t(error)}
        </p>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <div
          className={`${showDetails ? 'hidden xl:flex' : 'flex'} min-w-0 flex-1 flex-col`}
        >
          <section
            ref={timelineRef}
            role="log"
            aria-label={t('view.timeline')}
            onScroll={(event) => {
              const el = event.currentTarget;
              stickToBottom.current =
                el.scrollHeight - el.scrollTop - el.clientHeight < 80;
            }}
            className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-4 sm:px-5"
          >
            {view.messages.length === 0 ? (
              <p className="m-auto text-muted">{t('view.noMessages')}</p>
            ) : null}
            <ol className="flex flex-col gap-3" data-testid="timeline">
              {view.messages.map((message) => {
                const own = message.authorType === 'OPERATOR';
                const offers = view.shownOffers.filter(
                  (offer) => offer.messageId === message.id,
                );
                const quotes = view.quotes.filter(
                  (quote) => quote.shownInMessageId === message.id,
                );
                const failed =
                  message.deliveryState === 'FAILED' ||
                  message.deliveryState === 'UNKNOWN';
                return (
                  <li
                    key={message.id}
                    data-author={message.authorType}
                    className={`flex max-w-[88%] min-w-0 flex-col gap-1 px-3.5 py-2.5 sm:max-w-[78%] ${BUBBLE[message.authorType] ?? BUBBLE.CUSTOMER}`}
                  >
                    <p
                      className={`flex items-center gap-1.5 text-xs ${own ? 'text-on-primary-muted' : 'text-muted'}`}
                    >
                      <Icon
                        name={AUTHOR_ICON[message.authorType] ?? 'user'}
                        className="h-3 w-3"
                      />
                      {t(`author.${message.authorType}`)} ·{' '}
                      {formatDateTime(message.createdAt, props.timeZone)}
                    </p>
                    {/* Customer text is untrusted: plain text only, never HTML. */}
                    <p className="break-words whitespace-pre-wrap">
                      {message.text}
                    </p>
                    {offers.map((offer) => (
                      <div
                        key={offer.id}
                        className="mt-1 rounded-lg border border-line bg-surface p-2 text-sm text-fg"
                      >
                        <p className="font-medium">{offer.offerRef}</p>
                        {factLines(offer.facts).map((line) => (
                          <p key={line}>{line}</p>
                        ))}
                      </div>
                    ))}
                    {quotes.map((quote) => (
                      <p
                        key={quote.id}
                        className="mt-1 rounded-lg bg-surface p-2 text-sm text-fg"
                      >
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
                      <p
                        className={`flex items-center gap-1 text-xs ${
                          failed
                            ? 'font-semibold text-warning-fg'
                            : 'text-on-primary-muted'
                        }`}
                      >
                        {failed ? (
                          <span className="rounded bg-warning-soft px-1.5 py-0.5 text-warning-fg">
                            <Icon
                              name="alert"
                              className="mr-1 inline h-3 w-3"
                            />
                            {t(`delivery.${message.deliveryState}`)}
                          </span>
                        ) : (
                          <>
                            <Icon name="check" className="h-3 w-3" />
                            {t(`delivery.${message.deliveryState}`)}
                          </>
                        )}
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          </section>

          <div className="shrink-0 border-t border-line bg-surface p-3">
            {canTake ? (
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <p className="flex items-center gap-2 text-sm text-muted">
                  <Icon name="clock" />
                  {t('view.waitingBanner')}
                </p>
                <Button
                  variant="primary"
                  icon="headset"
                  className="w-full sm:w-auto"
                  data-testid="take-over"
                  loading={busy}
                  onClick={() => command.mutate({ action: 'take-over' })}
                >
                  {t('action.takeOver')}
                </Button>
              </div>
            ) : null}
            {canAct ? (
              <form onSubmit={send} className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Select
                    aria-label={t('action.canned')}
                    value=""
                    onChange={(e) =>
                      e.target.value &&
                      setReply(
                        (prev) =>
                          `${prev}${prev ? '\n' : ''}${t(`canned.${e.target.value}`)}`,
                      )
                    }
                    className="max-w-full"
                  >
                    <option value="">{t('action.cannedNone')}</option>
                    {CANNED.map((id) => (
                      <option key={id} value={id}>
                        {t(`canned.${id}`)}
                      </option>
                    ))}
                  </Select>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      data-testid="return-to-bot"
                      disabled={busy}
                      icon="bot"
                      onClick={() => setConfirm('return-to-bot')}
                    >
                      {t('action.returnToBot')}
                    </Button>
                    <Button
                      size="sm"
                      data-testid="close"
                      disabled={busy}
                      icon="x"
                      onClick={() => setConfirm('close')}
                    >
                      {t('action.close')}
                    </Button>
                  </div>
                </div>
                <textarea
                  data-testid="reply-input"
                  aria-label={t('action.replyPlaceholder')}
                  placeholder={t('action.replyPlaceholder')}
                  value={reply}
                  maxLength={4096}
                  rows={3}
                  onChange={(e) => setReply(e.target.value)}
                  onKeyDown={onReplyKey}
                  className={`${textareaClass} min-h-24 resize-y`}
                />
                <div className="flex items-center justify-between gap-3">
                  <p className="hidden text-xs text-muted sm:block">
                    {t('action.sendHint')}
                  </p>
                  <Button
                    type="submit"
                    variant="primary"
                    icon="send"
                    className="ml-auto"
                    data-testid="send-reply"
                    loading={busy}
                    disabled={!reply.trim()}
                  >
                    {busy ? t('action.sending') : t('action.reply')}
                  </Button>
                </div>
              </form>
            ) : null}
            {!canTake && !canAct && notice ? (
              <p className="flex items-center gap-2 text-sm text-muted">
                <Icon name="info" />
                {notice}
              </p>
            ) : null}
          </div>
        </div>

        <aside
          id="conversation-details"
          aria-label={t('view.details')}
          className={`${showDetails ? 'flex' : 'hidden xl:flex'} min-h-0 w-full shrink-0 flex-col gap-3 overflow-y-auto border-l border-line bg-canvas p-3 xl:w-80`}
        >
          <Section title={t('view.handover')} icon="headset">
            {view.handover ? (
              <>
                <p>{t('view.reason', { code: view.handover.reasonCode })}</p>
                {slaDue ? (
                  <p
                    className={`flex items-center gap-1.5 ${slaOverdue ? 'font-medium text-danger-fg' : 'text-muted'}`}
                  >
                    <Icon name="clock" />
                    {slaOverdue
                      ? t('list.sla')
                      : t('view.slaDue', {
                          date: formatDateTime(slaDue, props.timeZone),
                        })}
                  </p>
                ) : null}
                {summaryLines.map((line) => (
                  <p key={line} className="text-muted">
                    {line}
                  </p>
                ))}
              </>
            ) : (
              <p className="text-muted">{t('view.noHandover')}</p>
            )}
          </Section>
          <Section title={t('view.contact')} icon="user">
            <p>
              {view.contact.phone
                ? t('view.phone', { phone: view.contact.phone })
                : t('view.noPhone')}
            </p>
          </Section>
          <Section title={t('view.lead')} icon="inbox">
            {view.lead ? (
              <>
                <p>
                  <Badge tone={SCORE_TONE[view.lead.score]}>
                    {t(`score.${view.lead.score}`)}
                  </Badge>
                </p>
                <label className="flex flex-col gap-1 text-xs text-muted">
                  {t('view.leadStatus')}
                  <Select
                    value={view.lead.status}
                    disabled={!operating || busy || !handoverId}
                    onChange={(e) =>
                      command.mutate({
                        action: 'lead-status',
                        body: { status: e.target.value },
                      })
                    }
                  >
                    {LEAD_STATUSES.map((status) => (
                      <option key={status} value={status}>
                        {t(`leadStatus.${status}`)}
                      </option>
                    ))}
                  </Select>
                </label>
              </>
            ) : (
              <p className="text-muted">{t('view.noLead')}</p>
            )}
          </Section>
          <ActionsPanel
            conversationId={props.id}
            actions={view.actions ?? []}
            canResolve={operating}
            timeZone={props.timeZone}
          />
          <Section title={t('view.slots')} icon="message">
            {slots.length === 0 ? (
              <p className="text-muted">{t('view.noSlots')}</p>
            ) : (
              slots.map((line) => <p key={line}>{line}</p>)
            )}
          </Section>
          <Section title={t('view.notes')} icon="note">
            {view.notes.length === 0 ? (
              <p className="text-muted">{t('view.noNotes')}</p>
            ) : null}
            <ul className="flex flex-col gap-1.5" data-testid="notes">
              {view.notes.map((entry) => (
                <li
                  key={entry.id}
                  className="rounded-lg bg-warning-soft p-2 break-words whitespace-pre-wrap text-warning-fg"
                >
                  {entry.text}
                </li>
              ))}
            </ul>
            {operating && handoverId ? (
              <form onSubmit={addNote} className="mt-1 flex flex-col gap-2">
                <textarea
                  aria-label={t('action.notePlaceholder')}
                  placeholder={t('action.notePlaceholder')}
                  value={note}
                  maxLength={4096}
                  rows={2}
                  onChange={(e) => setNote(e.target.value)}
                  className={`${textareaClass} text-sm`}
                />
                <Button type="submit" size="sm" disabled={busy || !note.trim()}>
                  {t('action.addNote')}
                </Button>
              </form>
            ) : null}
          </Section>
        </aside>
      </div>

      <ConfirmDialog
        open={confirm !== null}
        title={
          confirm === 'close'
            ? t('confirm.closeTitle')
            : t('confirm.returnTitle')
        }
        body={
          confirm === 'close' ? t('confirm.closeBody') : t('confirm.returnBody')
        }
        confirmLabel={
          confirm === 'close' ? t('action.close') : t('action.returnToBot')
        }
        cancelLabel={t('confirm.cancel')}
        tone={confirm === 'close' ? 'danger' : 'primary'}
        busy={busy}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          if (confirm)
            command.mutate(
              { action: confirm },
              { onSettled: () => setConfirm(null) },
            );
        }}
      />
    </div>
  );
}
