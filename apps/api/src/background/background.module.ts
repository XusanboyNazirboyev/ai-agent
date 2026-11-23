import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module.js';
import { LeadLimitScanService } from '../access/lead-limit-scan.service.js';
import { SubscriptionScanService } from '../access/subscription-scan.service.js';
import { FollowUpService } from '../followup/follow-up.service.js';
import {
  HandoverRuntime,
  SCHEDULED_SCANS,
  type ScheduledScan,
} from '../handover/handover-runtime.js';
import { DigestService } from '../handover/digest.service.js';
import { HandoverModule } from '../handover/handover.module.js';
import { OperatorIdleReturnService } from '../handover/operator-idle-return.service.js';
import { ConnectorsModule } from '../connectors/connectors.module.js';
import { SheetCatalogService } from '../connectors/spreadsheet/sheet-catalog.service.js';
import { CrmStageSyncService } from '../connectors/bitrix24/crm-stage-sync.service.js';
import { SignupCleanupScan } from '../signup/signup-cleanup.scan.js';
import { LeadTaskReminders } from '../tasks/lead-tasks.js';
import { LeadSyncService } from '../leads/lead-sync.service.js';
import { LeadBackfillScan } from '../leads/lead-backfill.scan.js';
import { LeadsModule } from '../leads/leads.module.js';
import { ActionsModule } from '../actions/actions.module.js';
import { ActionService } from '../actions/action.service.js';
import { WebInboxModule } from '../webinbox/webinbox.module.js';
import { InboxEventsService } from '../webinbox/inbox-events.service.js';
import { AlertsService } from '../observability/alerts.service.js';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { RetentionModule } from '../retention/retention.module.js';
import { RetentionService } from '../retention/retention.service.js';
import { SecretsModule } from '../secrets/secrets.module.js';
import { CallPollScan } from '../telephony/call-poll.scan.js';

/**
 * The periodic scans of the API process: SLA alerts, CRM lead retries,
 * follow-ups, idle operator returns, subscription expiry (ADR 047), and
 * retention/envelope purge (P0.6, ADR 049). One interval, one overlap guard
 * (HandoverRuntime); each scan is idempotent, so several API processes may
 * run it.
 */
@Module({
  imports: [
    PersistenceModule,
    HandoverModule,
    LeadsModule,
    WebInboxModule,
    ActionsModule,
    AccessModule,
    RetentionModule,
    ConnectorsModule,
    SecretsModule,
  ],
  providers: [
    CallPollScan,
    LeadTaskReminders,
    SignupCleanupScan,
    FollowUpService,
    DigestService,
    AlertsService,
    OperatorIdleReturnService,
    {
      provide: SCHEDULED_SCANS,
      inject: [
        LeadSyncService,
        FollowUpService,
        DigestService,
        InboxEventsService,
        ActionService,
        AlertsService,
        OperatorIdleReturnService,
        SubscriptionScanService,
        LeadLimitScanService,
        RetentionService,
        SheetCatalogService,
        LeadTaskReminders,
        LeadBackfillScan,
        CrmStageSyncService,
        SignupCleanupScan,
        CallPollScan,
      ],
      useFactory: (
        lead: LeadSyncService,
        followUp: FollowUpService,
        digest: DigestService,
        inbox: InboxEventsService,
        actions: ActionService,
        alerts: AlertsService,
        idle: OperatorIdleReturnService,
        subscriptions: SubscriptionScanService,
        leadLimits: LeadLimitScanService,
        retention: RetentionService,
        sheets: SheetCatalogService,
        reminders: LeadTaskReminders,
        leadBackfill: LeadBackfillScan,
        crmStageSync: CrmStageSyncService,
        signupCleanup: SignupCleanupScan,
        callPoll: CallPollScan,
      ): ScheduledScan[] => [
        lead,
        followUp,
        digest,
        inbox,
        actions,
        alerts,
        idle,
        subscriptions,
        leadLimits,
        retention,
        sheets,
        reminders,
        leadBackfill,
        crmStageSync,
        signupCleanup,
        callPoll,
      ],
    },
    HandoverRuntime,
  ],
  exports: [FollowUpService, HandoverRuntime],
})
export class BackgroundModule {}
