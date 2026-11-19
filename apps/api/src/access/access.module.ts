import { Module } from '@nestjs/common';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { InboundAccessGate } from './inbound-access-gate.js';
import { LeadLimitScanService } from './lead-limit-scan.service.js';
import { SubscriptionScanService } from './subscription-scan.service.js';
import { TenantAccessService } from './tenant-access.service.js';

/**
 * Tenant access decisions (ADR 047 §3). Tenant modules import this, never
 * the platform console module.
 */
@Module({
  imports: [PersistenceModule],
  providers: [
    TenantAccessService,
    InboundAccessGate,
    SubscriptionScanService,
    LeadLimitScanService,
  ],
  exports: [
    TenantAccessService,
    InboundAccessGate,
    SubscriptionScanService,
    LeadLimitScanService,
  ],
})
export class AccessModule {}
