import type { PlatformRole } from './roles';
import type {
  PaymentRow,
  PendingInvite,
  Role,
  SubscriptionStatus,
  TenantAccess,
} from './types';

export type TenantStatus = 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED';

export interface PlatformAdmin {
  id: string;
  email: string;
  displayName: string;
  role: PlatformRole;
}

export interface PlatformMe {
  admin: PlatformAdmin | null;
}

export interface TenantSubscriptionSummary {
  id: string;
  status: SubscriptionStatus;
  planId: string;
  planCode: string;
  planName: string;
  currentPeriodEnd: string;
  graceUntil: string | null;
}

export interface TenantUsage {
  conversations: number;
  inboundMessages: number;
  llmCostUsd: number;
}

export interface TenantRow {
  id: string;
  slug: string;
  name: string;
  status: TenantStatus;
  createdAt: string;
  subscription: TenantSubscriptionSummary | null;
  usage: TenantUsage;
}

export interface TenantDetail {
  tenant: {
    id: string;
    slug: string;
    name: string;
    status: TenantStatus;
    defaultLocale: string;
    timezone: string;
    packKey: string;
    packVersion: string;
    createdAt: string;
  };
  access: TenantAccess;
  subscription: TenantSubscriptionSummary | null;
  usage: TenantUsage;
  operators: {
    id: string;
    displayName: string;
    role: Role;
    isActive: boolean;
    createdAt: string;
  }[];
  channels: { id: string; channelType: string; status: string }[];
  invites: PendingInvite[];
}

export interface SubscriptionHistoryRow {
  id: string;
  status: SubscriptionStatus;
  planId: string;
  planCode: string;
  planName: string;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  graceUntil: string | null;
  canceledAt: string | null;
  notes: string | null;
  createdAt: string;
}

export interface SubscriptionHistory {
  current: SubscriptionHistoryRow | null;
  history: SubscriptionHistoryRow[];
}

export interface PlatformPayment extends PaymentRow {
  subscriptionId: string | null;
  providerRef: string;
  recordedBy: string | null;
  summary: { note?: string } | null;
}

export interface PlanLimits {
  maxOperators?: number;
  maxChannelAccounts?: number;
  monthlyLlmBudgetUsd?: number;
}

export interface Plan {
  id: string;
  code: string;
  name: string;
  priceMinor: number;
  currency: string;
  periodDays: number;
  limits: PlanLimits | null;
  isActive: boolean;
  createdAt: string;
}

export interface PlatformAdminRow {
  id: string;
  email: string;
  displayName: string;
  role: PlatformRole;
  isActive: boolean;
  invitePending: boolean;
  inviteExpiresAt: string | null;
  createdAt: string;
}

export interface AuditEvent {
  id: string;
  action: string;
  actor: string | null;
  tenantId: string | null;
  tenant: { slug: string; name: string } | null;
  entityType: string;
  entityId: string | null;
  summary: Record<string, unknown> | null;
  createdAt: string;
}

export interface AuditPage {
  page: number;
  pageSize: number;
  total: number;
  events: AuditEvent[];
}

export interface TenantOptions {
  packs: string[];
  locales: string[];
}
