'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { api, ApiError, errorKey } from '@/lib/api';
import type { PersonDetail, PersonErasureResult, Role } from '@/lib/types';
import { Button } from './ui/button';
import { ConfirmDialog } from './ui/confirm-dialog';
import { Icon } from './ui/icons';
import { useToast } from './ui/toast';

/**
 * OWNER-only "Erase person" (ADR 052 slice D): erases every contact of the
 * person through `DELETE /api/v1/people/:id`. It is separate from the
 * per-contact erase on purpose (different label, counts in the body).
 */
export function ErasePersonButton(props: {
  person: PersonDetail;
  role: Role;
}): ReactNode {
  const { person, role } = props;
  const { t } = useI18n();
  const toast = useToast();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);

  const erase = useMutation({
    mutationFn: () =>
      api<PersonErasureResult>(`/api/v1/people/${person.id}`, {
        method: 'DELETE',
      }),
    onSuccess: (result) => {
      toast(t('toast.personErased', { contacts: result.contacts }));
      setOpen(false);
      void queryClient.invalidateQueries({ queryKey: ['people'] });
      void queryClient.invalidateQueries({ queryKey: ['person'] });
      void queryClient.invalidateQueries({ queryKey: ['person-duplicates'] });
      void queryClient.invalidateQueries({ queryKey: ['conversations'] });
      router.push('/contacts');
    },
    onError: (error) => {
      // Already erased (or merged away) by someone else: the card query shows
      // the not-found state once it is refetched.
      if (error instanceof ApiError && error.status === 404) {
        setOpen(false);
        void queryClient.invalidateQueries({ queryKey: ['people'] });
        void queryClient.invalidateQueries({ queryKey: ['person'] });
      }
    },
  });

  if (role !== 'OWNER') return null;

  return (
    <>
      <Button
        size="sm"
        variant="danger"
        onClick={() => {
          erase.reset();
          setOpen(true);
        }}
        data-testid="person-erase"
      >
        {t('people.erasePerson')}
      </Button>
      <ConfirmDialog
        open={open}
        title={t('people.erasePersonTitle')}
        body={t('people.erasePersonBody', {
          name: person.displayName ?? t('list.unnamed'),
          contacts: person.contacts.length,
          conversations: person.conversationCount,
        })}
        confirmLabel={t('people.erasePersonConfirm')}
        cancelLabel={t('confirm.cancel')}
        tone="danger"
        busy={erase.isPending}
        onConfirm={() => erase.mutate()}
        onCancel={() => {
          if (!erase.isPending) {
            erase.reset();
            setOpen(false);
          }
        }}
      />
      {erase.isError && open ? (
        <div
          role="alert"
          data-testid="person-erase-error"
          className="w-full text-sm text-danger-fg"
        >
          <p className="flex items-center gap-2">
            <Icon name="alert" />
            {t(errorKey(erase.error))}
          </p>
        </div>
      ) : null}
    </>
  );
}
