'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { api, errorKey } from '@/lib/api';
import type { ChannelAccount, ChannelList, TelegramTest } from '@/lib/types';
import { useShell } from './app-shell';
import { OperatorGroupDialog } from './operator-group-dialog';
import { TelegramConnectDialog } from './telegram-connect-dialog';
import { Badge, type Tone } from './ui/badge';
import { Button } from './ui/button';
import { ConfirmDialog } from './ui/confirm-dialog';
import { Icon, type IconName } from './ui/icons';
import { SkeletonRows } from './ui/skeleton';
import { useToast } from './ui/toast';

/** Product names are not translated. */
const CHANNELS: {
  key: 'telegram' | 'instagram' | 'whatsapp' | 'webchat';
  name: string;
  icon: IconName;
  available: boolean;
}[] = [
  { key: 'telegram', name: 'Telegram', icon: 'send', available: true },
  { key: 'instagram', name: 'Instagram', icon: 'message', available: false },
  { key: 'whatsapp', name: 'WhatsApp', icon: 'phone', available: false },
  { key: 'webchat', name: 'Web chat', icon: 'globe', available: false },
];

const MODE_TONE: Record<ChannelAccount['agentMode'], Tone> = {
  OFF: 'neutral',
  SHADOW: 'warning',
  LIVE: 'success',
};

function displayName(account: ChannelAccount): string {
  return (
    account.displayName ??
    CHANNELS.find((channel) => channel.key === account.channelType)?.name ??
    account.channelType
  );
}

function Check(props: { on: boolean; children: ReactNode }): ReactNode {
  return (
    <span
      className={`flex items-start gap-1.5 text-sm ${props.on ? '' : 'text-muted'}`}
    >
      <Icon
        name={props.on ? 'check' : 'x'}
        className={`mt-0.5 h-4 w-4 shrink-0 ${props.on ? 'text-success-fg' : ''}`}
      />
      <span className="min-w-0 break-words">{props.children}</span>
    </span>
  );
}

/** The result of "Check connection", as a short checklist. */
function TestResult(props: { result: TelegramTest }): ReactNode {
  const { t, formatDateTime } = useI18n();
  const { timeZone } = useShell();
  const r = props.result;
  const webhook = r.webhook;
  return (
    <div
      data-testid="test-result"
      className="flex flex-col gap-1.5 rounded-xl bg-surface-2 p-3"
    >
      <p className="text-sm font-medium">{t('test.title')}</p>
      <Check on={r.tokenValid}>
        {r.tokenValid
          ? t('test.tokenValid', { name: r.botUsername ?? '' })
          : t('test.tokenInvalid')}
      </Check>
      {webhook ? (
        <>
          <Check on={webhook.registered && webhook.matchesExpected !== false}>
            {!webhook.registered
              ? t('test.webhookMissing')
              : webhook.matchesExpected === false
                ? t('test.webhookWrong')
                : t('test.webhookOk')}
          </Check>
          {webhook.pendingUpdates > 0 ? (
            <Check on={false}>
              {t('test.pending', { count: webhook.pendingUpdates })}
            </Check>
          ) : null}
          {webhook.lastError ? (
            <Check on={false}>
              {t('test.lastError', {
                message: `${webhook.lastError}${
                  webhook.lastErrorAt
                    ? ` (${formatDateTime(webhook.lastErrorAt, timeZone)})`
                    : ''
                }`,
              })}
            </Check>
          ) : null}
        </>
      ) : null}
      <Check on={r.operatorGroupConfigured}>
        {r.operatorGroupConfigured ? t('test.groupOk') : t('test.groupMissing')}
      </Check>
    </div>
  );
}

/** One connected Telegram account: status, credentials and the actions on it. */
function AccountCard(props: {
  account: ChannelAccount;
  index: number;
  canManage: boolean;
  capabilities: ChannelList['capabilities'];
  onChanged: () => void;
  onReplace: () => void;
  onGroup: (account: ChannelAccount) => void;
}): ReactNode {
  const { t } = useI18n();
  const toast = useToast();
  const { account } = props;
  const [result, setResult] = useState<TelegramTest | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);
  const manageable = props.canManage && account.credentialSource === 'ui';

  const act = useMutation({
    mutationFn: (input: { path: string; method: 'POST' | 'DELETE' }) =>
      api<unknown>(`/api/v1/channels/${account.id}${input.path}`, {
        method: input.method,
      }),
    onSuccess: (data, input) => {
      if (input.path === '/test') setResult(data as TelegramTest);
      else {
        setResult(null);
        toast(
          t(
            input.path === '/enable'
              ? 'toast.channelEnabled'
              : input.path === '/disable'
                ? 'toast.channelDisabled'
                : 'toast.channelDisconnected',
          ),
        );
        props.onChanged();
      }
    },
    onSettled: () => setDisconnecting(false),
  });
  const enabled = account.status === 'ACTIVE';

  return (
    <li
      data-testid="channel-account"
      className="flex min-w-0 flex-col gap-3 rounded-2xl border border-line bg-surface p-4 shadow-card"
    >
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary-soft text-primary-fg">
            <Icon name="send" className="h-5 w-5" />
          </span>
          <span className="flex min-w-0 flex-col">
            {/* The bot's own name, from Telegram: plain text. */}
            <span data-testid="account-name" className="truncate font-medium">
              {displayName(account)}
            </span>
            <span className="text-xs text-muted">
              {t('channels.account', { number: props.index + 1 })}
            </span>
          </span>
        </span>
        <Badge tone={enabled ? 'success' : 'neutral'} dot>
          {t(`channelStatus.${account.status}`)}
        </Badge>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Badge tone={MODE_TONE[account.agentMode]}>
          {t(`agentMode.${account.agentMode}`)}
        </Badge>
        {account.isTestAccount ? (
          <Badge tone="accent">{t('channels.test')}</Badge>
        ) : null}
      </div>
      <div className="flex flex-col gap-1.5 border-t border-line pt-3">
        <Check on={account.credentialsConfigured}>
          {account.credentialsConfigured
            ? t('channels.credentialsOn')
            : t('channels.credentialsOff')}
        </Check>
        <Check on={account.operatorGroupConfigured}>
          {account.operatorGroupConfigured
            ? t('channels.groupOn')
            : t('channels.groupOff')}
        </Check>
        {account.webhookUrl && account.credentialSource === 'ui' ? (
          <span className="min-w-0 text-xs text-muted">
            {t('channels.webhookUrl')}:{' '}
            <span
              data-testid="webhook-url"
              className="font-mono break-all select-all"
            >
              {account.webhookUrl}
            </span>
          </span>
        ) : null}
        {account.credentialSource === 'environment' ? (
          <span className="text-xs text-muted">{t('channels.fromServer')}</span>
        ) : null}
      </div>
      {result ? <TestResult result={result} /> : null}
      {act.isError ? (
        <p
          role="alert"
          data-testid="account-error"
          className="flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger-fg"
        >
          <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
          {t(errorKey(act.error))}
        </p>
      ) : null}
      {manageable ? (
        <div className="flex flex-wrap gap-2 border-t border-line pt-3">
          {enabled ? (
            <Button
              size="sm"
              data-testid="account-disable"
              loading={act.isPending && act.variables?.path === '/disable'}
              onClick={() => act.mutate({ path: '/disable', method: 'POST' })}
            >
              {t('channels.disable')}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="primary"
              data-testid="account-enable"
              disabled={!props.capabilities.publicUrlConfigured}
              loading={act.isPending && act.variables?.path === '/enable'}
              onClick={() => act.mutate({ path: '/enable', method: 'POST' })}
            >
              {t('channels.enable')}
            </Button>
          )}
          <Button
            size="sm"
            icon="check"
            data-testid="account-test"
            loading={act.isPending && act.variables?.path === '/test'}
            onClick={() => act.mutate({ path: '/test', method: 'POST' })}
          >
            {t('channels.check')}
          </Button>
          <Button
            size="sm"
            icon="users"
            data-testid="account-group"
            onClick={() => props.onGroup(account)}
          >
            {t('channels.operatorGroup')}
          </Button>
          <Button
            size="sm"
            icon="pencil"
            data-testid="account-replace"
            onClick={props.onReplace}
          >
            {t('channels.replaceToken')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon="trash"
            data-testid="account-disconnect"
            onClick={() => setDisconnecting(true)}
          >
            {t('channels.disconnect')}
          </Button>
        </div>
      ) : null}
      <ConfirmDialog
        open={disconnecting}
        title={t('disconnect.title')}
        body={t('disconnect.body')}
        confirmLabel={t('channels.disconnect')}
        cancelLabel={t('confirm.cancel')}
        tone="danger"
        busy={act.isPending}
        onConfirm={() => act.mutate({ path: '', method: 'DELETE' })}
        onCancel={() => setDisconnecting(false)}
      />
    </li>
  );
}

/** What Instagram needs, from Meta's documentation (the adapter is not built yet). */
function InstagramGuide(): ReactNode {
  const { t } = useI18n();
  return (
    <details className="group rounded-xl bg-surface-2 p-3 text-sm">
      <summary className="flex cursor-pointer items-center justify-between gap-2 font-medium">
        {t('channels.instagramGuide')}
        <Icon
          name="chevronDown"
          className="h-4 w-4 shrink-0 text-muted transition-transform group-open:rotate-180"
        />
      </summary>
      <ol className="mt-2 flex list-decimal flex-col gap-1.5 pl-5 text-muted [overflow-wrap:anywhere]">
        {['1', '2', '3', '4', '5'].map((n) => (
          <li key={n}>{t(`instagram.step${n}`)}</li>
        ))}
      </ol>
      <p className="mt-2 text-xs text-muted">{t('channels.instagramSource')}</p>
    </details>
  );
}

/** Connected messenger accounts, with connecting, checking and disconnecting. */
export function ChannelsPage(): ReactNode {
  const { t } = useI18n();
  const { operator } = useShell();
  const queryClient = useQueryClient();
  const canManage = operator.role === 'OWNER' || operator.role === 'ADMIN';
  const [connecting, setConnecting] = useState<'new' | 'replace' | null>(null);
  const [groupFor, setGroupFor] = useState<ChannelAccount | null>(null);
  const query = useQuery({
    queryKey: ['channels'],
    queryFn: () => api<ChannelList>('/api/v1/channels'),
  });
  const items = query.data?.items ?? [];
  const capabilities = query.data?.capabilities ?? {
    secretsConfigured: false,
    publicUrlConfigured: false,
  };
  const changed = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['channels'] });
  };

  return (
    <div
      role="region"
      tabIndex={0}
      aria-label={t('nav.channels')}
      className="min-h-0 flex-1 overflow-y-auto"
    >
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-3 sm:p-6">
        <p className="text-sm text-muted">{t('channels.intro')}</p>
        {query.isSuccess && canManage && !capabilities.secretsConfigured ? (
          <p
            role="status"
            data-testid="needs-secrets"
            className="flex items-start gap-2 rounded-xl bg-warning-soft p-3 text-sm text-warning-fg"
          >
            <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
            {t('channels.needSecrets')}
          </p>
        ) : null}
        {query.isSuccess &&
        canManage &&
        capabilities.secretsConfigured &&
        !capabilities.publicUrlConfigured ? (
          <p
            role="status"
            data-testid="needs-url"
            className="flex items-start gap-2 rounded-xl bg-warning-soft p-3 text-sm text-warning-fg"
          >
            <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
            {t('channels.needUrl')}
          </p>
        ) : null}

        <section
          aria-labelledby="channels-connected"
          className="flex flex-col gap-3"
        >
          <h2 id="channels-connected" className="font-semibold">
            {t('channels.connected')}
          </h2>
          {query.isPending ? (
            <div
              role="status"
              className="overflow-hidden rounded-2xl border border-line bg-surface"
            >
              <span className="sr-only">{t('app.loading')}</span>
              <SkeletonRows rows={2} />
            </div>
          ) : null}
          {query.isError ? (
            <div className="flex flex-col items-start gap-3">
              <p
                role="alert"
                className="flex items-center gap-2 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger-fg"
              >
                <Icon name="alert" />
                {t(errorKey(query.error))}
              </p>
              <Button size="sm" onClick={() => void query.refetch()}>
                {t('app.retry')}
              </Button>
            </div>
          ) : null}
          {query.isSuccess && items.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-line bg-surface p-6 text-center text-sm text-muted">
              {t('channels.empty')}
            </p>
          ) : null}
          <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {items.map((account, index) => (
              <AccountCard
                key={account.id}
                account={account}
                index={index}
                canManage={canManage}
                capabilities={capabilities}
                onChanged={changed}
                onReplace={() => setConnecting('replace')}
                onGroup={setGroupFor}
              />
            ))}
          </ul>
        </section>

        <section
          aria-labelledby="channels-available"
          className="flex flex-col gap-3"
        >
          <h2 id="channels-available" className="font-semibold">
            {t('channels.available')}
          </h2>
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {CHANNELS.map((channel) => {
              const connected =
                channel.available &&
                items.some((account) => account.channelType === channel.key);
              return (
                <li
                  key={channel.key}
                  data-testid={`channel-card-${channel.key}`}
                  className="flex min-w-0 flex-col gap-3 rounded-2xl border border-line bg-surface p-4"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${
                        channel.available
                          ? 'bg-primary-soft text-primary-fg'
                          : 'bg-surface-2 text-muted'
                      }`}
                    >
                      <Icon name={channel.icon} className="h-5 w-5" />
                    </span>
                    <Badge
                      tone={
                        connected
                          ? 'success'
                          : channel.available
                            ? 'neutral'
                            : 'accent'
                      }
                    >
                      {channel.available
                        ? connected
                          ? t('channels.live')
                          : t('channels.notConnected')
                        : t('channels.planned')}
                    </Badge>
                  </div>
                  <h3 className="font-medium">{channel.name}</h3>
                  <p className="text-sm text-muted">
                    {t(`channels.desc.${channel.key}`)}
                  </p>
                  {channel.key === 'telegram' && canManage ? (
                    <Button
                      variant="primary"
                      icon="plus"
                      data-testid="connect-telegram"
                      disabled={!capabilities.secretsConfigured}
                      onClick={() => setConnecting('new')}
                    >
                      {t('channels.connectTelegram')}
                    </Button>
                  ) : null}
                  {channel.key === 'instagram' ? <InstagramGuide /> : null}
                </li>
              );
            })}
          </ul>
        </section>

        <p className="flex items-start gap-2 rounded-xl bg-surface-2 p-3 text-sm text-muted">
          <Icon name="info" className="mt-0.5 h-4 w-4 shrink-0" />
          {t('channels.adminNote')}
        </p>
      </div>

      <TelegramConnectDialog
        open={connecting !== null}
        replacing={connecting === 'replace'}
        canEnable={capabilities.publicUrlConfigured}
        onClose={() => setConnecting(null)}
        onChanged={changed}
      />
      <OperatorGroupDialog
        accountId={groupFor?.id ?? null}
        configured={groupFor?.operatorGroupConfigured ?? false}
        onClose={() => setGroupFor(null)}
        onChanged={changed}
      />
    </div>
  );
}
