import { Module } from '@nestjs/common';
import { FollowUpService } from '../followup/follow-up.service.js';
import {
  HandoverRuntime,
  SCHEDULED_SCANS,
  type ScheduledScan,
} from '../handover/handover-runtime.js';
import { HandoverModule } from '../handover/handover.module.js';
import { LeadSyncService } from '../leads/lead-sync.service.js';
import { LeadsModule } from '../leads/leads.module.js';
import { PersistenceModule } from '../persistence/persistence.module.js';

/**
 * The periodic scans of the API process: SLA alerts, CRM lead retries and
 * follow-ups. One interval, one overlap guard (HandoverRuntime); each scan is
 * idempotent, so several API processes may run it.
 */
@Module({
  imports: [PersistenceModule, HandoverModule, LeadsModule],
  providers: [
    FollowUpService,
    {
      provide: SCHEDULED_SCANS,
      inject: [LeadSyncService, FollowUpService],
      useFactory: (
        lead: LeadSyncService,
        followUp: FollowUpService,
      ): ScheduledScan[] => [lead, followUp],
    },
    HandoverRuntime,
  ],
  exports: [FollowUpService, HandoverRuntime],
})
export class BackgroundModule {}
