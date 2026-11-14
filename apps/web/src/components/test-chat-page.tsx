'use client';

import { useMutation } from '@tanstack/react-query';
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
import { reasonLabel } from '@/lib/handover-text';
import { slotPairs } from '@/lib/slot-labels';
import {
  newChat,
  requestBody,
  TEST_CHAT_MAX_TEXT,
  toolLabelKeys,
  withReply,
  type TestChatReply,
  type TestChatState,
} from '@/lib/test-chat';
import { useShell } from './app-shell';
import { SettingsSubPage } from './settings-section-nav';
import { Avatar } from './ui/avatar';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { textareaClass } from './ui/fields';
import { Icon } from './ui/icons';

const STARTERS = ['hello', 'offer', 'price', 'person'] as const;

/**
 * Try the assistant without a customer (ADR 065): the dialogue is held here
 * and sent with every message; nothing is saved or sent anywhere.
 */
export function TestChatPage(): ReactNode {
  const { t } = useI18n();
  const { operator } = useShell();
  const manage = operator.role === 'OWNER' || operator.role === 'ADMIN';
  const [chat, setChat] = useState<TestChatState | null>(null);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const end = useRef<HTMLDivElement | null>(null);

  // A fresh id per chat; created after mount (never during render on the server).
  useEffect(() => {
    setChat(newChat(crypto.randomUUID()));
  }, []);
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'end' });
  }, [chat?.messages.length, pending]);

  const send = useMutation({
    mutationFn: (input: { state: TestChatState; text: string }) =>
      api<TestChatReply>('/api/v1/assistant/test-chat', {
        method: 'POST',
        body: requestBody(input.state, input.text),
      }),
    onMutate: (input) => setPending(input.text),
    onSuccess: (reply, input) => {
      setChat((current) =>
        current && current.sessionId === input.state.sessionId
          ? withReply(current, input.text, reply)
          : current,
      );
      setDraft('');
    },
    onSettled: () => setPending(null),
  });

  function submit(text: string): void {
    const value = text.trim();
    if (!chat || !value || send.isPending) return;
    send.mutate({ state: chat, text: value });
  }
  function onSubmit(event: FormEvent): void {
    event.preventDefault();
    submit(draft);
  }
  function onKey(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (
      event.key === 'Enter' &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      submit(draft);
    }
  }
  function startOver(): void {
    send.reset();
    setDraft('');
    setPending(null);
    setChat(newChat(crypto.randomUUID()));
  }

  if (!manage)
    return (
      <SettingsSubPage active="bot">
        <p className="p-4 text-sm text-muted">{t('settings.readOnly')}</p>
      </SettingsSubPage>
    );

  const messages = chat?.messages ?? [];
  const details = chat ? slotPairs(chat.slots, (key) => t(key)) : [];

  return (
    <SettingsSubPage active="bot">
      <div
        role="region"
        tabIndex={0}
        aria-label={t('testChat.title')}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-3 p-3 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="flex min-w-0 flex-col gap-1">
              <h2 className="text-lg font-semibold">{t('testChat.title')}</h2>
              <p className="text-sm text-muted">{t('testChat.intro')}</p>
              <p className="text-xs text-muted">{t('testChat.costNote')}</p>
            </div>
            <Button
              size="sm"
              data-testid="test-chat-reset"
              onClick={startOver}
              disabled={messages.length === 0 && !send.isPending}
            >
              {t('testChat.startOver')}
            </Button>
          </div>

          <div
            role="log"
            aria-live="polite"
            aria-label={t('testChat.log')}
            data-testid="test-chat-log"
            className="flex min-h-60 flex-1 flex-col gap-3 overflow-y-auto rounded-2xl border border-line bg-canvas p-3 sm:p-4"
          >
            {messages.length === 0 && !pending ? (
              <div className="m-auto flex max-w-md flex-col items-center gap-3 text-center">
                <span className="grid h-12 w-12 place-items-center rounded-2xl bg-primary-soft text-primary-fg">
                  <Icon name="bot" className="h-6 w-6" />
                </span>
                <p className="text-sm text-muted">{t('testChat.empty')}</p>
                <div className="flex flex-wrap justify-center gap-2">
                  {STARTERS.map((key) => (
                    <button
                      key={key}
                      type="button"
                      data-testid={`test-chat-starter-${key}`}
                      onClick={() => submit(t(`testChat.starter.${key}`))}
                      className="min-h-9 rounded-full border border-line bg-surface px-3 text-sm hover:bg-surface-2"
                    >
                      {t(`testChat.starter.${key}`)}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {messages.map((message, index) =>
              message.role === 'customer' ? (
                <div
                  key={index}
                  data-testid="test-chat-customer"
                  className="flex max-w-[85%] flex-col gap-0.5 self-end rounded-2xl rounded-br-md bg-primary px-3 py-2 text-white"
                >
                  <span className="text-xs text-on-primary-muted">
                    {t('testChat.you')}
                  </span>
                  <p className="break-words whitespace-pre-wrap">
                    {message.text}
                  </p>
                </div>
              ) : (
                <div
                  key={index}
                  data-testid="test-chat-assistant"
                  className="flex max-w-[90%] items-start gap-2 self-start"
                >
                  <Avatar name={t('testChat.assistant')} />
                  <div className="flex min-w-0 flex-col gap-1.5 rounded-2xl rounded-tl-md border border-line bg-surface px-3 py-2">
                    <span className="text-xs text-muted">
                      {t('testChat.assistant')}
                    </span>
                    {/* The model's reply: plain text only, never HTML. */}
                    <p className="break-words whitespace-pre-wrap">
                      {message.text}
                    </p>
                    {message.handover ? (
                      <Badge tone="warning" className="self-start">
                        <Icon name="headset" className="h-3 w-3" />
                        {t('testChat.handover', {
                          reason: reasonLabel(t, message.handover),
                        })}
                      </Badge>
                    ) : null}
                    {toolLabelKeys(message.toolsUsed ?? []).length > 0 ? (
                      <span className="flex flex-wrap items-center gap-1.5">
                        {toolLabelKeys(message.toolsUsed ?? []).map((key) => (
                          <Badge key={key}>{t(key)}</Badge>
                        ))}
                      </span>
                    ) : null}
                  </div>
                </div>
              ),
            )}

            {pending ? (
              <>
                <div className="flex max-w-[85%] flex-col gap-0.5 self-end rounded-2xl rounded-br-md bg-primary px-3 py-2 text-white">
                  <span className="text-xs text-on-primary-muted">
                    {t('testChat.you')}
                  </span>
                  <p className="break-words whitespace-pre-wrap">{pending}</p>
                </div>
                <p
                  className="self-start text-sm text-muted motion-safe:animate-pulse"
                  data-testid="test-chat-thinking"
                >
                  {t('testChat.thinking')}
                </p>
              </>
            ) : null}
            <div ref={end} />
          </div>

          {details.length > 0 ? (
            <div
              className="flex flex-wrap items-center gap-1.5 text-xs text-muted"
              data-testid="test-chat-details"
            >
              <span>{t('testChat.collected')}:</span>
              {details.map((slot) => (
                <Badge key={slot.label}>
                  {slot.label}: {slot.value}
                </Badge>
              ))}
            </div>
          ) : null}

          {send.isError ? (
            <p
              role="alert"
              data-testid="test-chat-error"
              className="text-sm text-danger-fg"
            >
              {t(errorKey(send.error))}
            </p>
          ) : null}

          <form
            onSubmit={onSubmit}
            className="sticky bottom-0 -mx-3 flex items-end gap-2 border-t border-line bg-canvas px-3 py-2 sm:-mx-6 sm:px-6"
          >
            <textarea
              aria-label={t('testChat.placeholder')}
              placeholder={t('testChat.placeholder')}
              data-testid="test-chat-input"
              value={draft}
              maxLength={TEST_CHAT_MAX_TEXT}
              rows={2}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onKey}
              className={`${textareaClass} min-w-0 flex-1`}
            />
            <Button
              type="submit"
              variant="primary"
              icon="send"
              data-testid="test-chat-send"
              loading={send.isPending}
              disabled={!draft.trim() || !chat}
            >
              {t('testChat.send')}
            </Button>
          </form>
        </div>
      </div>
    </SettingsSubPage>
  );
}
