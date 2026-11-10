'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { inviteUrl } from '@/lib/invite-link';
import { Button } from './ui/button';
import { fieldClass } from './ui/fields';
import { Icon } from './ui/icons';

/**
 * The invite link, shown once (ADR 047 §5): the API never returns the token
 * again, so this box says so and offers a copy button. The link is not
 * logged or stored anywhere in the browser.
 */
export function InviteLinkBox(props: {
  path: string;
  expiresAt: string;
  email: string;
}): ReactNode {
  const { t, formatDateTime } = useI18n();
  const [origin, setOrigin] = useState('');
  const [copied, setCopied] = useState<'idle' | 'done' | 'failed'>('idle');
  const input = useRef<HTMLInputElement>(null);
  const fieldId = useId();
  useEffect(() => setOrigin(window.location.origin), []);
  const url = origin ? inviteUrl(props.path, origin) : undefined;

  async function copy(): Promise<void> {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied('done');
    } catch {
      // No clipboard permission: select the text for a manual copy.
      input.current?.select();
      setCopied('failed');
    }
  }

  return (
    <div
      data-testid="invite-link"
      className="flex flex-col gap-3 rounded-xl border border-line bg-surface-2 p-3"
    >
      <p className="flex items-start gap-2 text-sm font-medium">
        <Icon
          name="check"
          className="mt-0.5 h-4 w-4 shrink-0 text-success-fg"
        />
        {t('invite.created', { email: props.email })}
      </p>
      <label htmlFor={fieldId} className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium">{t('invite.link')}</span>
        <input
          id={fieldId}
          ref={input}
          readOnly
          data-testid="invite-url"
          value={url ?? ''}
          onFocus={(e) => e.currentTarget.select()}
          className={`${fieldClass} font-mono text-sm`}
        />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="primary"
          icon="link"
          data-testid="invite-copy"
          disabled={!url}
          onClick={() => void copy()}
        >
          {t('invite.copy')}
        </Button>
        <span role="status" className="text-sm text-muted">
          {copied === 'done'
            ? t('invite.copied')
            : copied === 'failed'
              ? t('invite.copyFailed')
              : ''}
        </span>
      </div>
      <p className="flex items-start gap-2 rounded-lg bg-warning-soft px-3 py-2 text-sm text-warning-fg">
        <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
        {t('invite.once', { date: formatDateTime(props.expiresAt) })}
      </p>
    </div>
  );
}
