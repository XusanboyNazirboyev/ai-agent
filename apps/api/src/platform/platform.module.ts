import { Module } from '@nestjs/common';
import { MfaModule } from '../auth/mfa.module.js';
import { AccessModule } from '../access/access.module.js';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { TeamModule } from '../team/team.module.js';
import { PlatformAdminsController } from './platform-admins.controller.js';
import { PlatformAuditController } from './platform-audit.controller.js';
import { PlatformAuthController } from './platform-auth.controller.js';
import { PlatformBillingController } from './platform-billing.controller.js';
import { PlatformOverviewController } from './platform-overview.controller.js';
import { PlatformPlansController } from './platform-plans.controller.js';
import { PlatformSessionGuard } from './platform-session.guard.js';
import { PlatformSessionService } from './platform-session.service.js';
import { PlatformTenantsController } from './platform-tenants.controller.js';
import { TelegramManagement } from '../channels/telegram/telegram-management.js';
import { SecretsModule } from '../secrets/secrets.module.js';
import { WebInboxModule } from '../webinbox/webinbox.module.js';
import { SignInController } from './sign-in.controller.js';

/**
 * Platform console API (ADR 047): `/api/v1/platform/**`, its own principal,
 * session table and cookies. The one place that reads across tenants; only
 * `app.module.ts` imports this directory (asserted by a unit test).
 */
@Module({
  imports: [
    PersistenceModule,
    AccessModule,
    TeamModule,
    MfaModule,
    SecretsModule,
    // ADR 096: the shared sign-in page also runs the tenant login flow.
    WebInboxModule,
  ],
  controllers: [
    PlatformAuthController,
    PlatformTenantsController,
    PlatformBillingController,
    PlatformOverviewController,
    PlatformPlansController,
    PlatformAdminsController,
    PlatformAuditController,
    SignInController,
  ],
  providers: [PlatformSessionService, PlatformSessionGuard, TelegramManagement],
})
export class PlatformModule {}
