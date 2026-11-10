import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module.js';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { TeamModule } from '../team/team.module.js';
import { PlatformAdminsController } from './platform-admins.controller.js';
import { PlatformAuditController } from './platform-audit.controller.js';
import { PlatformAuthController } from './platform-auth.controller.js';
import { PlatformBillingController } from './platform-billing.controller.js';
import { PlatformPlansController } from './platform-plans.controller.js';
import { PlatformSessionGuard } from './platform-session.guard.js';
import { PlatformSessionService } from './platform-session.service.js';
import { PlatformTenantsController } from './platform-tenants.controller.js';

/**
 * Platform console API (ADR 047): `/api/v1/platform/**`, its own principal,
 * session table and cookies. The one place that reads across tenants; only
 * `app.module.ts` imports this directory (asserted by a unit test).
 */
@Module({
  imports: [PersistenceModule, AccessModule, TeamModule],
  controllers: [
    PlatformAuthController,
    PlatformTenantsController,
    PlatformBillingController,
    PlatformPlansController,
    PlatformAdminsController,
    PlatformAuditController,
  ],
  providers: [PlatformSessionService, PlatformSessionGuard],
})
export class PlatformModule {}
