import type { ConfigService } from '@nestjs/config';
import {
  effectiveAgentModeWithReason,
  modeRefusalCode,
  type AgentModePolicy,
  type AgentModeValue,
  type EffectiveAgentMode,
  type ModeRefusalCode,
} from '../agent/agent-mode.js';
import type { AppEnvironment } from '../config/environment.js';

const MODES: AgentModeValue[] = ['OFF', 'SHADOW', 'LIVE'];

/** Where an account's bot credentials come from (never the credentials). */
export type CredentialSource = 'ui' | 'environment' | 'none';

export interface ChannelAccountSummary {
  id: string;
  channelType: string;
  /** For Telegram the bot's @username, when known. */
  displayName: string | null;
  status: 'ACTIVE' | 'DISABLED';
  agentMode: AgentModeValue;
  /**
   * What the pipeline really does now, computed by the same function it
   * calls. HOLD: no model call and nothing is sent, so customers get no reply.
   */
  effectiveMode: EffectiveAgentMode;
  /** Why effectiveMode differs from agentMode (absent when it does not). */
  effectiveReason?: ModeRefusalCode;
  /** Why a mode cannot be selected right now (absent: it can). */
  modeRefusals: Partial<Record<AgentModeValue, ModeRefusalCode>>;
  isTestAccount: boolean;
  credentialSource: CredentialSource;
  credentialsConfigured: boolean;
  /** Where Telegram delivers updates for this account; null until the server knows its public URL. */
  webhookUrl: string | null;
  operatorGroupConfigured: boolean;
  createdAt: Date;
}

export interface ChannelRow {
  id: string;
  channelType: string;
  displayName: string | null;
  status: 'ACTIVE' | 'DISABLED';
  agentMode: AgentModeValue;
  isTestAccount: boolean;
  operatorChatId: string | null;
  createdAt: Date;
}

/** The one policy source (agent-mode.ts), under the name the controllers use. */
export { agentModePolicyFrom as policyFrom } from '../agent/agent-mode.js';

/**
 * Credentials count as "ui" only with both secrets saved (token and webhook
 * secret); the environment bot counts for the one account it names.
 */
export function credentialSource(
  row: { id: string },
  savedPurposes: ReadonlySet<string>,
  config: ConfigService<AppEnvironment, true>,
): CredentialSource {
  if (savedPurposes.has('bot_token') && savedPurposes.has('webhook_secret'))
    return 'ui';
  const served = config.get('TELEGRAM_CHANNEL_ACCOUNT_ID', { infer: true });
  const token = config.get('TELEGRAM_BOT_TOKEN', { infer: true });
  return served === row.id && token ? 'environment' : 'none';
}

export function summarizeChannel(
  row: ChannelRow,
  policy: AgentModePolicy,
  source: CredentialSource,
  publicBaseUrl?: string,
): ChannelAccountSummary {
  const modeRefusals: ChannelAccountSummary['modeRefusals'] = {};
  for (const mode of MODES) {
    const code = modeRefusalCode(mode, policy, row);
    if (code) modeRefusals[mode] = code;
  }
  const effective = effectiveAgentModeWithReason(row.agentMode, policy, row);
  return {
    id: row.id,
    channelType: row.channelType,
    displayName: row.displayName,
    status: row.status,
    agentMode: row.agentMode,
    effectiveMode: effective.mode,
    ...(effective.reason ? { effectiveReason: effective.reason } : {}),
    modeRefusals,
    isTestAccount: row.isTestAccount,
    credentialSource: source,
    credentialsConfigured: source !== 'none',
    webhookUrl:
      row.channelType === 'telegram' && publicBaseUrl
        ? `${publicBaseUrl.replace(/\/+$/u, '')}/webhooks/telegram/${row.id}`
        : null,
    operatorGroupConfigured: Boolean(row.operatorChatId),
    createdAt: row.createdAt,
  };
}
