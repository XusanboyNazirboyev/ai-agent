'use client';

import { useMutation } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { api, errorKey } from '@/lib/api';
import { Button, buttonClass } from './ui/button';
import { Icon } from './ui/icons';

/**
 * ADR 092: connects the owner's own Telegram account (Telegram Business) to
 * the platform bot. The owner consents first (Telegram ToS §5.4); the link
 * opens the bot, which explains the last step in Telegram's settings.
 */
export function TelegramBusinessDialog(props: {
  open: boolean;
  onClose: () => void;
}): ReactNode {
  const { t } = useI18n();
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [consent, setConsent] = useState(false);
  const [link, setLink] = useState<string | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (props.open && !dialog.open) {
      setConsent(false);
      setLink(null);
      dialog.showModal();
    }
    if (!props.open && dialog.open) dialog.close();
  }, [props.open]);

  const create = useMutation({
    mutationFn: () =>
      api<{ url: string; expiresAt: string }>(
        '/api/v1/channels/telegram-business/link',
        { method: 'POST', body: { consent: true } },
      ),
    onSuccess: (result) => setLink(result.url),
  });

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      data-testid="telegram-business-dialog"
      onCancel={(event) => {
        event.preventDefault();
        props.onClose();
      }}
      onClick={(event) => {
        if (event.target === ref.current) props.onClose();
      }}
      className="m-auto w-[min(94vw,30rem)] rounded-2xl border border-line bg-surface p-0 text-fg shadow-pop"
    >
      <div className="flex flex-col gap-4 p-5">
        <h2 id={titleId} className="text-lg font-semibold">
          {t('business.title')}
        </h2>
        <p className="text-sm text-muted">{t('business.hint')}</p>
        <ol className="list-decimal space-y-1 ps-5 text-sm">
          <li>{t('business.step1')}</li>
          <li>{t('business.step2')}</li>
          <li>{t('business.step3')}</li>
        </ol>
        {link === null ? (
          <>
            <label className="flex items-start gap-2.5 text-sm">
              <input
                type="checkbox"
                data-testid="business-consent"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
              />
              <span>{t('business.consent')}</span>
            </label>
            <Button
              variant="primary"
              data-testid="business-link-create"
              disabled={!consent}
              loading={create.isPending}
              onClick={() => {
                if (!create.isPending) create.mutate();
              }}
            >
              {t('business.create')}
            </Button>
          </>
        ) : (
          <>
            <a
              href={link}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="business-link-open"
              className={buttonClass('primary')}
            >
              {t('business.open')}
            </a>
            <p className="text-sm text-muted" role="status">
              {t('business.waiting')}
            </p>
          </>
        )}
        {create.error ? (
          <p
            role="alert"
            className="flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger-fg"
          >
            <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
            {t(errorKey(create.error))}
          </p>
        ) : null}
        <div className="flex justify-end">
          <Button onClick={props.onClose}>{t('business.close')}</Button>
        </div>
      </div>
    </dialog>
  );
}
