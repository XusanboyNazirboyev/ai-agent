'use client';

import { useMutation } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { api, platformApi } from '@/lib/api';
import { InviteLinkBox } from './invite-link-box';
import { Button } from './ui/button';
import { ErrorNote } from './ui/error-note';
import { FormDialog } from './ui/form-dialog';

interface IssuedReset {
  path: string;
  expiresAt: string;
  email: string;
}

/**
 * "Password link" for one person (ADR 047 amendment 2026-11-17): makes a
 * one-time, 24-hour reset link and shows it to copy and send by hand. Used
 * on the console's customer page and on the tenant's Team page.
 */
export function PasswordResetLink(props: {
  /** API path that issues the link. */
  endpoint: string;
  /** Which session calls it: the console's or the tenant's. */
  via: 'platform' | 'tenant';
  name: string;
}): ReactNode {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const issue = useMutation({
    mutationFn: () =>
      props.via === 'platform'
        ? platformApi<IssuedReset>(props.endpoint, { method: 'POST' })
        : api<IssuedReset>(props.endpoint, { method: 'POST' }),
  });
  useEffect(() => {
    if (!open) issue.reset();
  }, [open]);
  const created = issue.data;

  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        data-testid="password-reset-open"
        onClick={() => setOpen(true)}
      >
        {t('passwordReset.button')}
      </Button>
      <FormDialog
        open={open}
        title={t('passwordReset.title', { name: props.name })}
        description={created ? undefined : t('passwordReset.body')}
        testId="password-reset-dialog"
        onClose={() => setOpen(false)}
        onSubmit={() => {
          if (created) setOpen(false);
          else if (!issue.isPending) issue.mutate();
        }}
        footer={
          created ? (
            <Button type="submit" variant="primary" data-testid="dialog-done">
              {t('action.done')}
            </Button>
          ) : (
            <>
              <Button
                onClick={() => setOpen(false)}
                data-testid="dialog-cancel"
              >
                {t('confirm.cancel')}
              </Button>
              <Button
                type="submit"
                variant="primary"
                loading={issue.isPending}
                data-testid="password-reset-create"
              >
                {t('passwordReset.create')}
              </Button>
            </>
          )
        }
      >
        {created ? (
          <InviteLinkBox
            path={created.path}
            expiresAt={created.expiresAt}
            email={created.email}
            title={t('passwordReset.created', { email: created.email })}
            label={t('passwordReset.button')}
          />
        ) : (
          <ErrorNote error={issue.error} />
        )}
      </FormDialog>
    </>
  );
}
