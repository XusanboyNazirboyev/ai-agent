'use client';

import { useMutation } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { api, errorKey } from '@/lib/api';
import { reasonLabel } from '@/lib/handover-text';
import { toolLabelKeys } from '@/lib/test-chat';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Icon } from './ui/icons';

interface Suggestion {
  reply: string | null;
  handover: string | null;
  toolsUsed: string[];
  basedOnMessageId: string;
}

/**
 * The "Assistant suggestion" card above the reply box (ADR 066). It is asked
 * for, never automatic; the operator sends it as it is, edits it first or
 * dismisses it. Nothing here writes anything until the operator sends.
 */
export function SuggestionCard(props: {
  conversationId: string;
  /** The customer's newest message: a suggestion for an older one is stale. */
  latestCustomerMessageId: string | null;
  disabled: boolean;
  onSend: (text: string, done: () => void) => void;
  onEdit: (text: string) => void;
}): ReactNode {
  const { t } = useI18n();
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const ask = useMutation({
    mutationFn: () =>
      api<Suggestion>(
        `/api/v1/inbox/conversations/${props.conversationId}/suggest-reply`,
        { method: 'POST' },
      ),
    onSuccess: (data) => setSuggestion(data),
  });
  const stale =
    suggestion !== null &&
    props.latestCustomerMessageId !== null &&
    suggestion.basedOnMessageId !== props.latestCustomerMessageId;
  const askButton = (
    <Button
      size="sm"
      icon="bot"
      data-testid="suggest-ask"
      loading={ask.isPending}
      disabled={props.disabled || props.latestCustomerMessageId === null}
      onClick={() => ask.mutate()}
    >
      {suggestion ? t('suggest.again') : t('suggest.ask')}
    </Button>
  );

  if (!suggestion && !ask.isPending && !ask.isError)
    return <div className="flex">{askButton}</div>;

  return (
    <section
      data-testid="suggestion"
      aria-label={t('suggest.title')}
      aria-busy={ask.isPending}
      className="flex flex-col gap-2 rounded-xl border border-primary/40 bg-primary-soft p-3 text-sm"
    >
      <p className="flex items-center gap-1.5 text-xs font-semibold text-primary-fg">
        <Icon name="bot" className="h-3.5 w-3.5" />
        {t('suggest.title')}
      </p>
      {ask.isPending ? (
        <p
          data-testid="suggest-writing"
          className="text-muted motion-safe:animate-pulse"
        >
          {t('suggest.writing')}
        </p>
      ) : null}
      {ask.isError ? (
        <p role="alert" data-testid="suggest-error" className="text-danger-fg">
          {t(errorKey(ask.error))}
        </p>
      ) : null}
      {!ask.isPending && suggestion ? (
        <>
          {suggestion.reply ? (
            <>
              {/* The model's text: plain text only, never HTML. */}
              <p
                data-testid="suggest-text"
                className="break-words whitespace-pre-wrap text-fg"
              >
                {suggestion.reply}
              </p>
              {toolLabelKeys(suggestion.toolsUsed).length > 0 ? (
                <span className="flex flex-wrap gap-1.5">
                  {toolLabelKeys(suggestion.toolsUsed).map((key) => (
                    <Badge key={key}>{t(key)}</Badge>
                  ))}
                </span>
              ) : null}
              <p className="text-xs text-muted">{t('suggest.hint')}</p>
            </>
          ) : (
            <p data-testid="suggest-none" className="text-fg">
              {t('suggest.none', {
                reason: reasonLabel(t, suggestion.handover ?? ''),
              })}
            </p>
          )}
          {stale ? (
            <p
              data-testid="suggest-stale"
              className="flex items-center gap-1.5 text-xs font-medium text-warning-fg"
            >
              <Icon name="alert" className="h-3.5 w-3.5" />
              {t('suggest.stale')}
            </p>
          ) : null}
        </>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {suggestion?.reply && !ask.isPending ? (
          <>
            <Button
              size="sm"
              variant="primary"
              icon="send"
              data-testid="suggest-send"
              disabled={props.disabled}
              onClick={() =>
                props.onSend(suggestion.reply!, () => setSuggestion(null))
              }
            >
              {t('suggest.send')}
            </Button>
            <Button
              size="sm"
              icon="pencil"
              data-testid="suggest-edit"
              disabled={props.disabled}
              onClick={() => {
                props.onEdit(suggestion.reply!);
                setSuggestion(null);
              }}
            >
              {t('suggest.edit')}
            </Button>
          </>
        ) : null}
        {!ask.isPending ? askButton : null}
        <Button
          size="sm"
          variant="ghost"
          data-testid="suggest-dismiss"
          onClick={() => {
            ask.reset();
            setSuggestion(null);
          }}
        >
          {t('suggest.dismiss')}
        </Button>
      </div>
    </section>
  );
}
