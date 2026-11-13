export type ConversationState =
  'BOT_ACTIVE' | 'WAITING_OPERATOR' | 'OPERATOR_ACTIVE' | 'CLOSED';
export type Scope = 'all' | 'waiting' | 'closed';
export type Role = 'OWNER' | 'ADMIN' | 'OPERATOR' | 'VIEWER';
export type LeadScore = 'HOT' | 'WARM' | 'COLD';
export type LeadStatus = 'NEW' | 'IN_PROGRESS' | 'WON' | 'LOST';
export interface LeadStage {
  id: string;
  code: string | null;
  name: string | null;
  position: number;
  /** ADR 058: OPEN stages are the funnel, WON/LOST are closed. */
  kind: 'OPEN' | 'WON' | 'LOST';
  /** ADR 057: the pipeline this stage belongs to. */
  pipelineId: string;
}

/** A pipeline (ADR 057): `name === null` is the unnamed default pipeline. */
export interface PipelineView {
  id: string;
  name: string | null;
  position: number;
  isDefault: boolean;
  /** ADR 058 decision 5: who may move leads along the funnel automatically. */
  aiStaging: 'OFF' | 'SUGGEST' | 'AUTO';
  stageCount: number;
  leadCount: number;
}

/** ADR 058 decision 7: one board response, per stage count + totals. */
export interface BoardStageView {
  id: string;
  code: string | null;
  name: string | null;
  kind: 'OPEN' | 'WON' | 'LOST';
  position: number;
  count: number;
  /** One total per currency; decimal strings, never summed as JS numbers. */
  totals: Array<{ currency: string; amount: string }>;
}

/** Body of `PATCH /api/v1/leads/:id/opportunity` (ADR 057). */
export interface OpportunityPatch {
  ownerOperatorId?: string | null;
  amount?: string | null;
  currency?: string | null;
  source?: string | null;
  expectedCloseDate?: string | null;
  lostReason?: string | null;
}

/** Opportunity fields of a lead (ADR 057), as returned by the leads list. */
export interface OpportunityView {
  id: string;
  status: LeadStatus;
  pipelineId: string;
  ownerOperatorId: string | null;
  owner: { id: string; displayName: string } | null;
  /** Decimal string (`1500.50`), never a JS number. */
  amount: string | null;
  currency: string | null;
  source: string | null;
  /** `YYYY-MM-DD`. */
  expectedCloseDate: string | null;
  lostReason: string | null;
}

export interface LeadPipelineItem {
  id: string;
  /** ADR 057 (additive). */
  pipelineId: string;
  pipelineStageId: string | null;
  ownerOperatorId: string | null;
  owner: { id: string; displayName: string } | null;
  amount: string | null;
  currency: string | null;
  source: string | null;
  expectedCloseDate: string | null;
  lostReason: string | null;
  /** ADR 058: who set the stage; AGENT means AI may move it (unless opted out). */
  stageSetBy: 'AGENT' | 'OPERATOR';
  suggestedStageId: string | null;
  suggestedReasonCodes: string[];
  score: LeadScore;
  status: LeadStatus;
  summary: string;
  createdAt: string;
  updatedAt: string;
  contact: { name: string | null; phone: string | null };
  conversation: {
    id: string;
    state: ConversationState;
    channelType: string;
  };
  /** P1.5: tags on the lead (additive). */
  tags?: TagRef[];
  /** P1.5: active custom field values (additive). */
  customFields?: CustomFieldEntry[];
}

export interface LeadPipelinePage {
  items: LeadPipelineItem[];
  nextCursor: string | null;
}
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

export type AccessState =
  'ok' | 'SUSPENDED' | 'ARCHIVED' | 'SUBSCRIPTION_EXPIRED';

/** What the tenant may do right now (ADR 047 §3), from `GET /me`. */
export interface TenantAccess {
  state: AccessState;
  periodEnd: string | null;
  graceUntil: string | null;
}

export interface Me {
  operator: { id: string; displayName: string; role: Role } | null;
  tenant: { timezone: string; defaultLocale: string } | null;
  /** Absent on an API older than ADR 047. */
  access?: TenantAccess;
}

export interface TeamMember {
  id: string;
  displayName: string;
  role: Role;
  isActive: boolean;
  email: string | null;
  createdAt: string;
}

export interface PendingInvite {
  id: string;
  email: string;
  role: Role;
  expiresAt: string;
  createdAt: string;
}

export interface TeamView {
  operators: TeamMember[];
  invites: PendingInvite[];
  limits: { maxOperators: number | null; seatsUsed: number };
}

/** An invite as created: the token and link exist only in this response. */
export interface CreatedInvite {
  id: string;
  email: string;
  role: string;
  expiresAt: string;
  token: string;
  path: string;
}

export interface InvitePreview {
  email: string;
  role: Role;
  tenantName: string;
  expiresAt: string;
}

export type SubscriptionStatus =
  'TRIAL' | 'ACTIVE' | 'PAST_DUE' | 'EXPIRED' | 'CANCELED';
export type PaymentStatus = 'PENDING' | 'PAID' | 'FAILED' | 'REFUNDED';

export interface PaymentRow {
  id: string;
  provider: 'MANUAL' | 'CLICK';
  amountMinor: number;
  currency: string;
  status: PaymentStatus;
  paidAt: string | null;
  createdAt: string;
}

export interface OwnSubscription {
  access: TenantAccess;
  subscription: {
    status: SubscriptionStatus;
    planName: string;
    priceMinor: number;
    currency: string;
    periodDays: number;
    currentPeriodStart: string;
    currentPeriodEnd: string;
    graceUntil: string | null;
    canceledAt: string | null;
  } | null;
  payments: PaymentRow[];
}

export interface ConversationListItem {
  id: string;
  state: ConversationState;
  contactName: string | null;
  language: string | null;
  leadScore: LeadScore | null;
  leadStatus: LeadStatus | null;
  /** The score was set by an operator (ADR 037). */
  leadScoreSetByOperator: boolean;
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
    /** Set by an operator; automatic scoring keeps it (ADR 037). */
    scoreSetByOperator: boolean;
    status: LeadStatus;
    summary: string;
    crmSyncStatus:
      'PENDING' | 'SYNCED' | 'NOT_REQUIRED' | 'FAILED' | 'UNCERTAIN' | string;
    /** P1.5: tags/custom fields on lead (additive). */
    tags?: TagRef[];
    customFields?: CustomFieldEntry[];
  } | null;
  messages: {
    id: string;
    authorType: 'CUSTOMER' | 'BOT' | 'OPERATOR' | 'SYSTEM';
    direction: string;
    type: string;
    text: string;
    /** ADR 042: set on customer voice notes. */
    voiceStatus?: 'PENDING' | 'TRANSCRIBED' | 'FAILED' | null;
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
/** What the server really does; HOLD: no model call and nothing is sent. */
export type EffectiveMode = AgentMode | 'HOLD';
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
  effectiveMode: EffectiveMode;
  effectiveReason?: ModeRefusal;
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

/** Result of owner-initiated contact erasure (ADR 049). */
export interface ContactErasureResult {
  contactId: string;
  alreadyErased: boolean;
  conversations: number;
  messagesRedacted: number;
}

/** Result of owner-initiated whole-person erasure (ADR 052 slice D). */
export interface PersonErasureResult {
  personId: string;
  contacts: number;
  conversations: number;
  messagesRedacted: number;
}

/** P1.5: tag attached to a person or lead (ADR 053). */
export interface TagRef {
  id: string;
  name: string;
  color: string | null;
}

export type CustomFieldEntity = 'PERSON' | 'LEAD';
export type CustomFieldType = 'TEXT' | 'NUMBER' | 'DATE' | 'BOOLEAN' | 'SELECT';
export type CustomFieldValue = string | number | boolean | null;

/** P1.5: tenant-defined custom field definition (ADR 053). */
export interface CustomFieldDef {
  id: string;
  entity: CustomFieldEntity;
  key: string;
  label: string;
  type: CustomFieldType;
  options: string[] | null;
  position: number;
}

/** Tag as managed in settings, including usage counts. */
export interface Tag extends TagRef {
  usage: { people: number; leads: number };
}

/** Custom field value resolved against active definitions. */
export interface CustomFieldEntry {
  key: string;
  label: string;
  type: CustomFieldType;
  value: CustomFieldValue;
}

export interface PersonItem {
  id: string;
  displayName: string | null;
  phone: string | null;
  channels: Array<{ contactId: string; channelType: string }>;
  conversationCount: number;
  leadCount: number;
  lastConversationId: string | null;
  lastActivityAt: string | null;
  marketingOptOut: boolean;
  createdAt: string;
  /** P1.5: tags on the person (additive; empty when API is older). */
  tags?: TagRef[];
}

export interface PersonList {
  items: PersonItem[];
  nextCursor: string | null;
}

export interface PersonLastMerge {
  id: string;
  mergedAt: string;
  contacts: number;
}

export interface PersonDetail extends PersonItem {
  lastMerge: PersonLastMerge | null;
  contacts: Array<{
    id: string;
    channelType: string;
    channelName: string | null;
    name: string | null;
    phone: string | null;
    language: string | null;
    consentStatus: 'UNKNOWN' | 'GRANTED' | 'REVOKED';
    marketingOptOut: boolean;
    createdAt: string;
  }>;
  conversations: Array<{
    id: string;
    contactId: string;
    channelType: string;
    state: ConversationState;
    updatedAt: string;
  }>;
  leads: Array<{
    id: string;
    contactId: string;
    status: LeadStatus;
    score: LeadScore;
    stageName: string | null;
    updatedAt: string;
  }>;
  /** P1.5: active custom field values in definition order (ADR 053). */
  customFields?: CustomFieldEntry[];
}

export interface PersonMergePreview {
  source: PersonItem;
  survivor: PersonItem;
  moves: {
    contacts: number;
    conversations: number;
    leads: number;
  };
}

export interface PersonDuplicateGroup {
  reason: 'PHONE';
  persons: PersonItem[];
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

/** A connected CRM (ADR 032); the saved credential itself is never sent. */
export interface ConnectorSummary {
  id: string;
  connectorKey: string;
  status: 'ACTIVE' | 'DISABLED' | 'ERROR';
  configured: boolean;
}

export interface ConnectorList {
  items: ConnectorSummary[];
  secretsConfigured: boolean;
}

/** GET /api/v1/analytics (Section 11 metrics, 12A.6). */
export interface AnalyticsReport {
  range: { from: string; to: string; timezone: string; days: number };
  conversations: {
    total: number;
    byLanguage: { language: string; count: number }[];
    daily: { day: string; count: number }[];
  };
  firstResponse: {
    asked: number;
    answered: number;
    p50Seconds: number | null;
    p95Seconds: number | null;
  };
  resolution: {
    total: number;
    autoResolved: number;
    handedOver: number;
    autoResolvedRate: number | null;
    handoverRate: number | null;
  };
  handovers: {
    total: number;
    byReason: { reason: string; count: number }[];
    daily: { day: string; count: number }[];
    takeOverP50Seconds: number | null;
    slaAlerted: number;
  };
  leads: {
    total: number;
    byScore: { score: string; count: number }[];
    captureRate: number | null;
    crmFailed: number;
    crmPending: number;
  };
  guardrail: {
    turns: number;
    blockedTurns: number;
    blockRate: number | null;
    guardrailHandovers: number;
  };
  latency: { turns: number; p50Ms: number | null; p95Ms: number | null };
  cost: {
    conversationsWithTurns: number;
    totalUsd: number;
    perConversationUsd: number | null;
    inputTokens: number;
    outputTokens: number;
  };
  tools: { calls: number; errors: number; errorRate: number | null };
  languageDetection: {
    messages: number;
    averageConfidence: number | null;
    lowConfidence: number;
  };
}
