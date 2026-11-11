'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { api, ApiError, errorKey } from '@/lib/api';
import { channelName } from '@/lib/channel-names';
import type { ContactErasureResult, PersonDetail, Role } from '@/lib/types';
import { useShell } from './app-shell';
import { Avatar } from './ui/avatar';
import { Badge } from './ui/badge';
import { Button, buttonClass } from './ui/button';
import { ConfirmDialog } from './ui/confirm-dialog';
import { Icon } from './ui/icons';
import { SkeletonRows } from './ui/skeleton';
import { useToast } from './ui/toast';

interface ContactRow {
  id: string;
  channelType: string;
  channelName: string | null;
  name: string | null;
  phone: string | null;
  language: string | null;
  consentStatus: 'UNKNOWN' | 'GRANTED' | 'REVOKED';
  marketingOptOut: boolean;
  createdAt: string;
}

const CONSENT_TONE = {
  GRANTED: 'success',
  REVOKED: 'danger',
  UNKNOWN: 'neutral',
} as const;

const STATE_TONE = {
  BOT_ACTIVE: 'success',
  WAITING_OPERATOR: 'warning',
  OPERATOR_ACTIVE: 'accent',
  CLOSED: 'neutral',
} as const;

const SCORE_TONE = {
  HOT: 'danger',
  WARM: 'warning',
  COLD: 'neutral',
} as const;

export function PersonPage(): ReactNode {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const { t } = useI18n();
  const query = useQuery({
    queryKey: ['person', id],
    queryFn: () => api<PersonDetail>(`/api/v1/people/${id}`),
    retry: false,
  });

  return (
    <div
      role="region"
      tabIndex={0}
      aria-label={t('people.cardTitle')}
      className="min-h-0 flex-1 overflow-y-auto"
    >
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-3 sm:p-6">
        <Link
          href="/contacts"
          className="inline-flex w-fit items-center gap-2 text-sm text-muted hover:text-fg"
        >
          <Icon name="chevronLeft" />
          {t('people.back')}
        </Link>

        {query.isPending ? (
          <div
            role="status"
            className="overflow-hidden rounded-2xl border border-line bg-surface"
          >
            <span className="sr-only">{t('app.loading')}</span>
            <SkeletonRows rows={5} />
          </div>
        ) : null}

        {query.isError ? <PersonError error={query.error} /> : null}
        {query.isSuccess ? <PersonDetailView person={query.data} /> : null}
      </div>
    </div>
  );
}

function PersonError(props: { error: unknown }): ReactNode {
  const { t } = useI18n();
  const is404 = props.error instanceof ApiError && props.error.status === 404;
  return (
    <div
      className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-line bg-surface px-6 py-10 text-center text-muted"
      data-testid={is404 ? 'person-not-found' : 'person-error'}
    >
      <span className="grid h-12 w-12 place-items-center rounded-2xl bg-surface-2">
        <Icon name={is404 ? 'users' : 'alert'} className="h-6 w-6" />
      </span>
      <p role="alert">
        {is404 ? t('people.notFound') : t(errorKey(props.error))}
      </p>
      <Link href="/contacts" className={buttonClass('secondary', 'sm')}>
        {t('people.back')}
      </Link>
    </div>
  );
}

function PersonDetailView(props: { person: PersonDetail }): ReactNode {
  const { person } = props;
  const { t, formatDateTime } = useI18n();
  const { timeZone, operator } = useShell();
  return (
    <div className="flex flex-col gap-4">
      <section
        data-testid="person-header"
        className="flex min-w-0 flex-wrap items-center gap-4 rounded-2xl border border-line bg-surface p-4 shadow-card"
      >
        <Avatar name={person.displayName} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h1 className="truncate text-lg font-semibold">
            {person.displayName ?? t('list.unnamed')}
          </h1>
          <p className="truncate text-sm text-muted">
            {person.phone ?? t('view.noPhone')}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {person.channels.map((ch) => (
              <Badge key={`${ch.contactId}-${ch.channelType}`}>
                {channelName(ch.channelType)}
              </Badge>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-1 text-sm text-muted">
          <span>
            {t('people.conversations', { count: person.conversationCount })}
          </span>
          <span>{t('people.leads', { count: person.leadCount })}</span>
          <span>
            {person.lastActivityAt
              ? t('people.lastActive', {
                  date: formatDateTime(person.lastActivityAt, timeZone),
                })
              : t('people.never')}
          </span>
        </div>
      </section>

      <Section title={t('people.contactsSection')} testId="person-contacts">
        {person.contacts.length === 0 ? (
          <p className="text-sm text-muted">{t('people.noContacts')}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {person.contacts.map((contact) => (
              <ContactCard
                key={contact.id}
                contact={contact}
                role={operator.role}
                personId={person.id}
              />
            ))}
          </ul>
        )}
      </Section>

      <Section
        title={t('people.conversationsSection')}
        testId="person-conversations"
      >
        {person.conversations.length === 0 ? (
          <p className="text-sm text-muted">{t('people.noConversations')}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {person.conversations.map((conv) => (
              <li
                key={conv.id}
                data-testid="person-conversation"
                className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-xl border border-line p-3"
              >
                <span className="flex flex-wrap items-center gap-2">
                  <Badge>{channelName(conv.channelType)}</Badge>
                  <Badge tone={STATE_TONE[conv.state]}>
                    {t(`state.${conv.state}`)}
                  </Badge>
                  <span className="text-xs text-muted">
                    {formatDateTime(conv.updatedAt, timeZone)}
                  </span>
                </span>
                <Link
                  href={`/inbox?scope=all&c=${conv.id}`}
                  className={buttonClass('secondary', 'sm')}
                >
                  {t('people.openConversation')}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={t('people.leadsSection')} testId="person-leads">
        {person.leads.length === 0 ? (
          <p className="text-sm text-muted">{t('people.noLeads')}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {person.leads.map((lead) => (
              <li
                key={lead.id}
                data-testid="person-lead"
                className="flex min-w-0 flex-wrap items-center gap-2 rounded-xl border border-line p-3"
              >
                <Badge>
                  {channelName(
                    lead.contactId
                      ? (person.channels.find(
                          (c) => c.contactId === lead.contactId,
                        )?.channelType ?? lead.contactId)
                      : '',
                  )}
                </Badge>
                <Badge tone={SCORE_TONE[lead.score]}>
                  {t(`score.${lead.score}`)}
                </Badge>
                <Badge>{t(`leadStatus.${lead.status}`)}</Badge>
                {lead.stageName ? <Badge>{lead.stageName}</Badge> : null}
                <span className="text-xs text-muted">
                  {formatDateTime(lead.updatedAt, timeZone)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function Section(props: {
  title: string;
  testId: string;
  children: ReactNode;
}): ReactNode {
  return (
    <section
      data-testid={props.testId}
      className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4 shadow-card"
    >
      <h2 className="text-sm font-semibold">{props.title}</h2>
      {props.children}
    </section>
  );
}

function ContactCard(props: {
  contact: ContactRow;
  role: Role;
  personId: string;
}): ReactNode {
  const { contact } = props;
  const { t, formatDateTime } = useI18n();
  const { timeZone } = useShell();
  const toast = useToast();
  const queryClient = useQueryClient();
  const canErase = props.role === 'OWNER';
  const [pendingErase, setPendingErase] = useState(false);

  const erase = useMutation({
    mutationFn: (contactId: string) =>
      api<ContactErasureResult>(`/api/v1/contacts/${contactId}`, {
        method: 'DELETE',
      }),
    onSuccess: (result) => {
      toast(
        result.alreadyErased
          ? t('toast.contactAlreadyErased')
          : t('toast.contactErased', {
              conversations: result.conversations,
              messages: result.messagesRedacted,
            }),
      );
      setPendingErase(false);
      void queryClient.invalidateQueries({
        queryKey: ['person', props.personId],
      });
      void queryClient.invalidateQueries({ queryKey: ['people'] });
      void queryClient.invalidateQueries({ queryKey: ['conversations'] });
    },
  });

  return (
    <li
      data-testid="person-contact"
      className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-3 rounded-xl border border-line p-3"
    >
      <span className="flex min-w-0 flex-1 basis-48 flex-col gap-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <Badge>{channelName(contact.channelType)}</Badge>
          {contact.channelName ? (
            <span className="text-sm text-muted">{contact.channelName}</span>
          ) : null}
        </span>
        <span className="truncate font-medium">
          {contact.name ?? t('list.unnamed')}
        </span>
        <span className="truncate text-sm text-muted">
          {contact.phone ?? t('view.noPhone')}
        </span>
      </span>
      <span className="flex min-w-0 flex-1 basis-40 flex-col gap-1.5">
        <span className="flex flex-wrap items-center gap-1.5">
          {contact.language ? (
            <Badge className="uppercase">{contact.language}</Badge>
          ) : null}
          <Badge tone={CONSENT_TONE[contact.consentStatus]}>
            {t(`people.consent.${contact.consentStatus}`)}
          </Badge>
          {contact.marketingOptOut ? (
            <Badge tone="warning">{t('people.optedOut')}</Badge>
          ) : null}
        </span>
        <span className="text-xs text-muted">
          {formatDateTime(contact.createdAt, timeZone)}
        </span>
      </span>
      {canErase ? (
        <Button
          size="sm"
          variant="danger"
          onClick={() => {
            erase.reset();
            setPendingErase(true);
          }}
          data-testid="person-contact-erase"
        >
          {t('contacts.erase')}
        </Button>
      ) : null}

      <ConfirmDialog
        open={pendingErase}
        title={t('contacts.eraseTitle')}
        body={t('contacts.eraseBody', {
          name: contact.name ?? t('list.unnamed'),
        })}
        confirmLabel={t('contacts.eraseConfirm')}
        cancelLabel={t('confirm.cancel')}
        tone="danger"
        busy={erase.isPending}
        onConfirm={() => erase.mutate(contact.id)}
        onCancel={() => {
          if (!erase.isPending) {
            erase.reset();
            setPendingErase(false);
          }
        }}
      />
      {erase.isError && pendingErase ? (
        <div
          role="alert"
          data-testid="person-contact-erase-error"
          className="fixed right-4 bottom-4 z-40 max-w-md rounded-xl border border-line bg-surface p-3 text-sm text-danger-fg shadow-pop"
        >
          <p className="flex items-center gap-2">
            <Icon name="alert" />
            {t(errorKey(erase.error))}
          </p>
        </div>
      ) : null}
    </li>
  );
}
