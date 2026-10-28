export type ConversationState =
  'BOT_ACTIVE' | 'WAITING_OPERATOR' | 'OPERATOR_ACTIVE' | 'CLOSED';
export type Scope = 'waiting' | 'mine' | 'all' | 'closed';
export type Role = 'OWNER' | 'ADMIN' | 'OPERATOR' | 'VIEWER';
export type LeadScore = 'HOT' | 'WARM' | 'COLD';
export type LeadStatus = 'NEW' | 'IN_PROGRESS' | 'WON' | 'LOST';
export type ActionStatus =
  | 'PROPOSED'
  | 'CONFIRMED'
  | 'DECLINED'
  | 'SUPERSEDED'
  | 'EXPIRED'
  | 'CANCELLED'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'UNCERTAIN';

export interface Me {
  operator: { id: string; displayName: string; role: Role } | null;
  tenant: { timezone: string; defaultLocale: string } | null;
}

export interface ConversationListItem {
  id: string;
  state: ConversationState;
  contactName: string | null;
  language: string | null;
  leadScore: LeadScore | null;
  assignedOperatorId: string | null;
  waitingSince: string | null;
  slaDueAt: string | null;
  updatedAt: string;
}

export interface ConversationPage {
  items: ConversationListItem[];
  nextCursor: string | null;
}

export interface ConversationView {
  conversation: {
    id: string;
    state: ConversationState;
    assignedOperatorId: string | null;
    language: string | null;
    script: string | null;
    version: number;
  };
  contact: { name: string | null; phone: string | null };
  handover: {
    id: string;
    reasonCode: string;
    status: string;
    summary: unknown;
    slaDueAt: string | null;
    openedAt: string;
  } | null;
  lead: {
    id: string;
    score: LeadScore;
    status: LeadStatus;
    summary: string;
  } | null;
  messages: {
    id: string;
    authorType: 'CUSTOMER' | 'BOT' | 'OPERATOR' | 'SYSTEM';
    direction: string;
    type: string;
    text: string;
    deliveryState: 'PENDING' | 'SENT' | 'FAILED' | 'UNKNOWN';
    createdAt: string;
  }[];
  shownOffers: {
    id: string;
    messageId: string;
    offerRef: string;
    facts: unknown;
    shownAt: string;
  }[];
  quotes: {
    id: string;
    amount: string;
    currency: string;
    validUntil: string | null;
    shownInMessageId: string | null;
  }[];
  slots: unknown;
  actions: {
    id: string;
    actionKey: string;
    status: ActionStatus;
    createdAt: string;
    outcomeAt: string | null;
    externalId: string | null;
    errorCode: string | null;
    payload: Record<string, string> | null;
  }[];
  notes: { id: string; operatorId: string; text: string; createdAt: string }[];
}

export type AgentMode = 'OFF' | 'SHADOW' | 'LIVE';
export type ModeRefusal =
  'UNTRUSTED_PROVIDER' | 'NO_OPERATOR_NOTIFIER' | 'UNTRUSTED_REAL_DATA';

export interface FaqItem {
  id: string;
  question: string;
  answer: string;
  language: string | null;
  regulated: boolean;
  updatedAt: string;
}

export interface ChannelAccount {
  id: string;
  channelType: string;
  status: 'ACTIVE' | 'DISABLED';
  agentMode: AgentMode;
  modeRefusals: Partial<Record<AgentMode, ModeRefusal>>;
  displayName: string | null;
  credentialSource: 'ui' | 'environment' | 'none';
  webhookUrl: string | null;
  isTestAccount: boolean;
  credentialsConfigured: boolean;
  operatorGroupConfigured: boolean;
  /** Enabled from the web before; the first enable drops queued updates. */
  everEnabled: boolean;
  createdAt: string;
}

export interface ContactItem {
  id: string;
  name: string | null;
  phone: string | null;
  language: string | null;
  channelType: string;
  marketingOptOut: boolean;
  conversationCount: number;
  lastConversationId: string | null;
  lastActivityAt: string | null;
  createdAt: string;
}

export interface ChannelList {
  items: ChannelAccount[];
  capabilities: { secretsConfigured: boolean; publicUrlConfigured: boolean };
}

export interface TelegramTest {
  tokenValid: boolean;
  botUsername: string | null;
  status: 'ACTIVE' | 'DISABLED';
  webhook: {
    registered: boolean;
    matchesExpected: boolean | null;
    pendingUpdates: number;
    lastError: string | null;
    lastErrorAt: string | null;
  } | null;
  operatorGroupConfigured: boolean;
}

export interface KnowledgeDocumentItem {
  id: string;
  title: string;
  language: string | null;
  topic: string | null;
  regulated: boolean;
  chunks: number;
  characters: number;
  origin: 'upload' | 'admin';
  preview: string;
  updatedAt: string;
}
