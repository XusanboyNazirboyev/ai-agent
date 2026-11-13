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
import { FormDialog } from './ui/form-dialog';
import { fieldClass } from './ui/fields';
import { api, errorKey } from '@/lib/api';
import { factLines } from '@/lib/facts';
import { handoverSummaryLines, reasonLabel } from '@/lib/handover-text';
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
import { LeadCustomFieldsEditor, LeadTagsEditor } from './lead-tags-fields';
import { Select } from './ui/select';
import { Icon, type IconName } from './ui/icons';
import { Section } from './ui/section';
import { MoveToPipeline } from './move-to-pipeline';
import { useToast } from './ui/toast';

const CANNED = ['greeting', 'wait', 'details', 'thanks', 'bye'];
const LEAD_STATUSES: LeadStatus[] = ['NEW', 'IN_PROGRESS', 'WON', 'LOST'];
const OPERATING: Role[] = ['OWNER', 'ADMIN', 'OPERATOR'];

type Action =
  | 'take-over'
  | 'return-to-bot'
  | 'close'
  | 'reply'
  | 'notes'
  | 'lead-status'
  | 'lead-score'
  | 'lead-crm-sync';

const TOAST: Record<Action, string> = {
  'take-over': 'toast.takeOver',
  'return-to-bot': 'toast.returnToBot',
  close: 'toast.close',
  reply: 'toast.reply',
  notes: 'toast.note',
  'lead-status': 'toast.leadStatus',
  'lead-score': 'toast.leadScore',
  'lead-crm-sync': 'toast.leadCrmSync',
};

const LEAD_SCORES: LeadScore[] = ['HOT', 'WARM', 'COLD'];

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
  const [lostDialog, setLostDialog] = useState(false);
  const [lostDraft, setLostDraft] = useState('');
  const timelineRef = useRef<HTMLElement>(null);
  const stickToBottom = useRef(true);
  const activeConversationId = useRef(props.id);

  const query = useQuery({
    queryKey: ['conversation', props.id],
    queryFn: () =>
      api<ConversationView>(`/api/v1/inbox/conversations/${props.id}`),
  });
  const view = query.data;

  useEffect(() => {
    activeConversationId.current = props.id;
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
    mutationFn: (input: {
      action: Action;
      body?: unknown;
      handoverId?: string;
    }) =>
      api(
        `/api/v1/handovers/${input.handoverId ?? handoverId}/${input.action}`,
        {
          method: 'POST',
          body: input.body,
          command: true,
        },
      ),
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
  // Operator mode (ADR 038): take the conversation from the bot (or from the
  // waiting queue) by conversation id; the bot stays silent from then on.
  const takeOver = useMutation({
    mutationFn: () =>
      api<{ handoverId: string; state: string }>(
        `/api/v1/handovers/by-conversation/${props.id}/take-over`,
        { method: 'POST', command: true },
      ),
    onMutate: () => setError(undefined),
    onError: (failure) => setError(errorKey(failure)),
    onSuccess: () => notify(t('toast.takeOver')),
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
  const canAct = operating && state === 'OPERATOR_ACTIVE' && mine && handoverId;
  // The composer is open whenever the operator could speak: writing to a
  // conversation the bot holds takes it over first (ADR 038).
  const canWrite =
    operating && state !== 'CLOSED' && !(state === 'OPERATOR_ACTIVE' && !mine);
  const busy = command.isPending || takeOver.isPending;
  const operatorMode =
    state === 'OPERATOR_ACTIVE' || state === 'WAITING_OPERATOR';
  function toOperator(): void {
    if (!busy && !(state === 'OPERATOR_ACTIVE' && mine)) takeOver.mutate();
  }
  function toAi(): void {
    if (!busy && state !== 'BOT_ACTIVE' && state !== 'CLOSED' && handoverId)
      command.mutate({ action: 'return-to-bot' });
  }
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
    const conversationId = props.id;
    const clearDraftIfStillActive = (): void => {
      if (activeConversationId.current === conversationId) setReply('');
    };
    const deliver = (id?: string): void =>
      command.mutate(
        { action: 'reply', body: { text }, ...(id ? { handoverId: id } : {}) },
        { onSuccess: clearDraftIfStillActive },
      );
    if (canAct) deliver();
    else
      takeOver.mutate(undefined, {
        onSuccess: (taken) => deliver(taken.handoverId),
      });
  }
  function onReplyChange(value: string): void {
    setReply(value);
    // The first keystroke moves the conversation to the operator.
    if (value.trim() && !canAct && !takeOver.isPending) toOperator();
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
  const summaryLines = handoverSummaryLines(
    t,
    view.handover?.summary,
    view.handover?.reasonCode,
  );
  const slots = factLines(view.slots);
  const slaDue = view.handover?.slaDueAt ?? null;
  const slaOverdue = slaDue ? Date.parse(slaDue) < now : false;
  const name = view.contact.name ?? t('list.unnamed');

  return (
    <div
      className="flex min-h-0 flex-1 flex-col bg-canvas"
      data-testid="conversation-view"
    >
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-surface px-3 py-2 sm:gap-3 sm:px-4">
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
        {canWrite ? (
          <div
            role="radiogroup"
            aria-label={t('mode.label')}
            className="order-last flex w-full gap-1 rounded-xl border border-line bg-surface-2 p-1 lg:order-none lg:w-auto lg:shrink-0"
          >
            <button
              type="button"
              role="radio"
              aria-checked={!operatorMode}
              data-testid="mode-ai"
              disabled={busy}
              onClick={toAi}
              className={`flex min-h-9 flex-1 items-center justify-center gap-1.5 rounded-lg px-3 text-sm font-medium transition-colors lg:flex-none ${
                !operatorMode
                  ? 'bg-primary text-white'
                  : 'text-muted hover:text-fg'
              }`}
            >
              <Icon name="bot" className="h-4 w-4" />
              {t('mode.ai')}
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={operatorMode}
              data-testid="take-over"
              disabled={busy}
              onClick={toOperator}
              className={`flex min-h-9 flex-1 items-center justify-center gap-1.5 rounded-lg px-3 text-sm font-medium transition-colors lg:flex-none ${
                operatorMode
                  ? 'bg-primary text-white'
                  : 'text-muted hover:text-fg'
              }`}
            >
              <Icon name="headset" className="h-4 w-4" />
              {t('mode.operator')}
            </button>
          </div>
        ) : null}
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
            // Focusable so the history can be scrolled from the keyboard.
            tabIndex={0}
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
                    {message.type === 'VOICE' ? (
                      <p
                        data-testid="voice-label"
                        className="flex items-center gap-1.5 text-xs font-medium"
                      >
                        <span aria-hidden="true">🎤</span>
                        {t(
                          message.voiceStatus === 'FAILED'
                            ? 'voice.failed'
                            : message.voiceStatus === 'PENDING'
                              ? 'voice.pending'
                              : 'voice.transcript',
                        )}
                      </p>
                    ) : null}
                    {message.type === 'COMMENT' ? (
                      <p
                        data-testid="comment-label"
                        className="flex items-center gap-1.5 text-xs font-medium"
                      >
                        <span aria-hidden="true">💬</span>
                        {t('comment.label')}
                      </p>
                    ) : null}
                    {/* Customer text is untrusted: plain text only, never HTML. */}
                    {message.text ? (
                      <p className="break-words whitespace-pre-wrap">
                        {message.text}
                      </p>
                    ) : null}
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
            {canWrite ? (
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
                  {canAct ? (
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
                  ) : null}
                </div>
                <textarea
                  data-testid="reply-input"
                  aria-label={t('action.replyPlaceholder')}
                  placeholder={t('action.replyPlaceholder')}
                  value={reply}
                  maxLength={4096}
                  rows={3}
                  onChange={(e) => onReplyChange(e.target.value)}
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
            {!canWrite && notice ? (
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
                <p>
                  {t('view.reason', {
                    code: reasonLabel(t, view.handover.reasonCode),
                  })}
                </p>
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
                <p className="flex flex-wrap items-center gap-2">
                  <Badge tone={SCORE_TONE[view.lead.score]}>
                    {t(`score.${view.lead.score}`)}
                  </Badge>
                  <span className="text-xs text-muted">
                    {view.lead.scoreSetByOperator
                      ? t('view.scoreByOperator')
                      : t('view.scoreAutomatic')}
                  </span>
                </p>
                <label className="flex flex-col gap-1 text-xs text-muted">
                  {t('view.leadScore')}
                  <Select
                    value={
                      view.lead.scoreSetByOperator ? view.lead.score : 'AUTO'
                    }
                    disabled={!operating || busy || !handoverId}
                    onChange={(e) =>
                      command.mutate({
                        action: 'lead-score',
                        body: {
                          score:
                            e.target.value === 'AUTO' ? null : e.target.value,
                        },
                      })
                    }
                  >
                    <option value="AUTO">{t('view.scoreAuto')}</option>
                    {LEAD_SCORES.map((score) => (
                      <option key={score} value={score}>
                        {t(`score.${score}`)}
                      </option>
                    ))}
                  </Select>
                </label>
                {view.lead.crmSyncStatus === 'NOT_REQUIRED' ? (
                  <div className="flex flex-col gap-1 text-xs text-muted">
                    <span>{t('view.crmNotSent')}</span>
                    <Button
                      size="sm"
                      disabled={!operating || busy || !handoverId}
                      data-testid="lead-crm-sync"
                      onClick={() =>
                        command.mutate({ action: 'lead-crm-sync' })
                      }
                    >
                      {t('view.crmSend')}
                    </Button>
                  </div>
                ) : null}
                <label className="flex flex-col gap-1 text-xs text-muted">
                  {t('view.leadStatus')}
                  <Select
                    value={view.lead.status}
                    disabled={!operating || busy || !handoverId}
                    onChange={(e) => {
                      if (
                        e.target.value === 'LOST' &&
                        view.lead?.status !== 'LOST'
                      ) {
                        setLostDraft('');
                        setLostDialog(true);
                        return;
                      }
                      command.mutate({
                        action: 'lead-status',
                        body: { status: e.target.value },
                      });
                    }}
                  >
                    {LEAD_STATUSES.map((status) => (
                      <option key={status} value={status}>
                        {t(`leadStatus.${status}`)}
                      </option>
                    ))}
                  </Select>
                </label>
                <FormDialog
                  open={lostDialog}
                  title={t('opportunity.lostReason')}
                  description={t('opportunity.lostReasonBody')}
                  testId="lead-lost-dialog"
                  onClose={() => setLostDialog(false)}
                  onSubmit={() => {
                    const reason = lostDraft.trim();
                    if (!reason) return;
                    command.mutate(
                      {
                        action: 'lead-status',
                        body: { status: 'LOST', lostReason: reason },
                      },
                      { onSuccess: () => setLostDialog(false) },
                    );
                  }}
                  footer={
                    <>
                      <Button
                        variant="secondary"
                        onClick={() => setLostDialog(false)}
                      >
                        {t('app.cancel')}
                      </Button>
                      <Button type="submit" variant="primary" loading={busy}>
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
                      maxLength={200}
                      className={fieldClass}
                      autoFocus
                      aria-label={t('opportunity.lostReason')}
                    />
                  </label>
                </FormDialog>
                <LeadTagsEditor
                  leadId={view.lead.id}
                  tags={view.lead.tags ?? []}
                  role={props.me.role}
                />
                <LeadCustomFieldsEditor
                  leadId={view.lead.id}
                  fields={view.lead.customFields ?? []}
                  role={props.me.role}
                />
                {operating ? <MoveToPipeline leadId={view.lead.id} /> : null}
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
