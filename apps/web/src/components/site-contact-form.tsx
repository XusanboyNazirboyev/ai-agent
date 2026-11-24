'use client';

import { useMutation } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { api, errorKey } from '@/lib/api';
import { Button } from './ui/button';
import { fieldClass, textareaClass } from './ui/fields';
import { Icon } from './ui/icons';

const EMPTY = { name: '', phone: '', company: '', message: '', website: '' };

/** The phone the form accepts: what the API accepts (digits, +, spaces, dashes). */
export function phoneLooksValid(phone: string): boolean {
  return /^\+?[\d\s()-]{7,32}$/u.test(phone.trim());
}

/**
 * Owner 2026-11-24: "contact us" on the sales page. The request is stored
 * and sent to the sales team's Telegram; a Telegram link sits beside it.
 */
export function SiteContactForm(props: {
  telegramUrl: string | null;
}): ReactNode {
  const { t, locale } = useI18n();
  const [form, setForm] = useState(EMPTY);
  const [invalid, setInvalid] = useState(false);
  const send = useMutation({
    mutationFn: () =>
      api<{ ok: true }>('/api/v1/public/inquiries', {
        method: 'POST',
        body: { ...form, locale },
      }),
  });
  function submit(event: FormEvent): void {
    event.preventDefault();
    const bad = form.name.trim().length < 2 || !phoneLooksValid(form.phone);
    setInvalid(bad);
    if (!bad) send.mutate();
  }
  const field = (key: keyof typeof EMPTY) => ({
    value: form[key],
    onChange: (e: { target: { value: string } }) =>
      setForm({ ...form, [key]: e.target.value }),
  });

  if (send.isSuccess)
    return (
      <div
        role="status"
        data-testid="site-contact-done"
        className="flex flex-col items-start gap-2 rounded-2xl bg-success-soft p-5 text-success-fg"
      >
        <Icon name="check" className="h-6 w-6" />
        <p className="font-semibold">{t('site.contact.doneTitle')}</p>
        <p className="text-sm">{t('site.contact.doneBody')}</p>
      </div>
    );

  return (
    <form
      onSubmit={submit}
      noValidate
      data-testid="site-contact-form"
      className="flex flex-col gap-3"
    >
      <label className="flex flex-col gap-1 text-sm font-medium">
        {t('site.contact.name')}
        <input
          {...field('name')}
          autoComplete="name"
          maxLength={80}
          required
          className={fieldClass}
          data-testid="site-contact-name"
        />
      </label>
      <label className="flex flex-col gap-1 text-sm font-medium">
        {t('site.contact.phone')}
        <input
          {...field('phone')}
          type="tel"
          autoComplete="tel"
          inputMode="tel"
          maxLength={32}
          required
          placeholder={t('site.contact.phoneExample')}
          className={fieldClass}
          data-testid="site-contact-phone"
        />
      </label>
      <label className="flex flex-col gap-1 text-sm font-medium">
        {t('site.contact.company')}
        <input
          {...field('company')}
          autoComplete="organization"
          maxLength={120}
          className={fieldClass}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm font-medium">
        {t('site.contact.message')}
        <textarea
          {...field('message')}
          rows={3}
          maxLength={500}
          className={textareaClass}
        />
      </label>
      {/* Hidden from people; a form-filling bot fills it and is ignored. */}
      <input
        {...field('website')}
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        className="hidden"
      />
      {invalid || send.isError ? (
        <p
          role="alert"
          className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger-fg"
        >
          {invalid ? t('site.contact.invalid') : t(errorKey(send.error))}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          variant="primary"
          loading={send.isPending}
          data-testid="site-contact-submit"
        >
          {t('site.contact.submit')}
        </Button>
        {props.telegramUrl ? (
          <a
            href={props.telegramUrl}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="site-contact"
            className="inline-flex min-h-11 items-center gap-2 text-sm font-medium underline"
          >
            <Icon name="send" className="h-4 w-4" />
            {t('site.contact.telegram')}
          </a>
        ) : null}
      </div>
    </form>
  );
}
