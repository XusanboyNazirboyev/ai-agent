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
