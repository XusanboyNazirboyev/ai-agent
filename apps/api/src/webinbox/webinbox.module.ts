import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { AppEnvironment } from "../config/environment.js";
import type { Bitrix24Transport } from "../connectors/bitrix24/bitrix24-client.js";
import { bitrix24TestTransport } from "./bitrix24-test-transport.js";
import {
  BITRIX24_CONNECT_TRANSPORT,
  ConnectorsController,
} from "./connectors.controller.js";
import { ConnectorsModule } from "../connectors/connectors.module.js";
import { ConnectorRolesController } from "./connector-roles.controller.js";
import { KnowledgeModule } from "../knowledge/knowledge.module.js";
import { TelegramManagement } from "../channels/telegram/telegram-management.js";
import { InstagramGraphClient } from "../channels/instagram/instagram-graph.js";
import { InstagramOAuthClient } from "../channels/instagram/instagram-oauth.js";
import {
  OAuthStateLedger,
  RedisOAuthStateLedger,
} from "../channels/instagram/instagram-oauth-state-ledger.js";
import { MfaModule } from "../auth/mfa.module.js";
import { SecretsModule } from "../secrets/secrets.module.js";
import { PersistenceModule } from "../persistence/persistence.module.js";
import { AccessModule } from "../access/access.module.js";
import { TeamModule } from "../team/team.module.js";
import { RetentionModule } from "../retention/retention.module.js";
import { TeamController } from "./team.controller.js";
import { SubscriptionController } from "./subscription.controller.js";
import { AuthController } from "./auth.controller.js";
import { AnalyticsController } from "./analytics.controller.js";
import { AnalyticsService } from "./analytics.service.js";
import { ChannelsController } from "./channels.controller.js";
import { ContactsController } from "./contacts.controller.js";
import { PeopleController } from "./people.controller.js";
import { PeopleService } from "../persons/people.service.js";
import { PersonErasureService } from "../persons/person-erasure.service.js";
import { PersonMergeService } from "../persons/person-merge.service.js";
import { TagsController } from "./tags.controller.js";
import { CustomFieldsController } from "./custom-fields.controller.js";
import { TagsService } from "../tags/tags.service.js";
import { CustomFieldsService } from "../tags/custom-fields.service.js";
import { ManualLeadService } from "../leads/manual-lead.service.js";
import { LeadsController } from "./leads.controller.js";
import { LeadPipelineController } from "./lead-pipeline.controller.js";
import { PipelinesController } from "./pipelines.controller.js";
import { FacebookConnectController } from "./facebook-connect.controller.js";
import { FacebookOAuthClient } from "../channels/facebook/facebook-oauth.js";
import { EventsController } from "./events.controller.js";
import { TelegramConnectController } from "./telegram-connect.controller.js";
import { InstagramConnectController } from "./instagram-connect.controller.js";
import { KnowledgeDocumentsController } from "./knowledge-documents.controller.js";
import { KnowledgeFaqController } from "./knowledge-faq.controller.js";
import { InboxController } from "./inbox.controller.js";
import { InboxEventBus } from "./inbox-event-bus.js";
import { InboxEventsService } from "./inbox-events.service.js";
import { InboxReadService } from "./inbox-read.service.js";
import { SessionGuard } from "./session.guard.js";
import { SessionService } from "./session.service.js";
import { ExportsController } from "./exports.controller.js";
import { ExportService } from "../exports/export.service.js";
import { ExportLock } from "../exports/export-lock.js";

/** Web Operator Inbox backend (Phase 6A, ADR 020). */
@Module({
  imports: [
    PersistenceModule,
    ConnectorsModule,
    KnowledgeModule,
    SecretsModule,
    AccessModule,
    TeamModule,
    MfaModule,
    RetentionModule,
  ],
  controllers: [
    AuthController,
    InboxController,
    EventsController,
    ChannelsController,
    TelegramConnectController,
    InstagramConnectController,
    KnowledgeFaqController,
    KnowledgeDocumentsController,
    ContactsController,
    PeopleController,
    TagsController,
    CustomFieldsController,
    ConnectorsController,
    ConnectorRolesController,
    LeadsController,
    AnalyticsController,
    LeadPipelineController,
    PipelinesController,
    FacebookConnectController,
    TeamController,
    SubscriptionController,
    ExportsController,
  ],
  providers: [
    ManualLeadService,
    PeopleService,
    TagsService,
    CustomFieldsService,
    PersonMergeService,
    PersonErasureService,
    AnalyticsService,
    ExportService,
    ExportLock,
    TelegramManagement,
    InstagramGraphClient,
    InstagramOAuthClient,
    FacebookOAuthClient,
    { provide: OAuthStateLedger, useClass: RedisOAuthStateLedger },
    {
      provide: BITRIX24_CONNECT_TRANSPORT,
      inject: [ConfigService],
      useFactory: (
        config: ConfigService<AppEnvironment, true>,
      ): Bitrix24Transport | null => {
        const base = config.get("BITRIX24_TEST_BASE_URL", { infer: true });
        return base ? bitrix24TestTransport(base) : null;
      },
    },
    SessionService,
    SessionGuard,
    InboxReadService,
    InboxEventsService,
    InboxEventBus,
  ],
  exports: [SessionService, SessionGuard, InboxEventsService],
})
export class WebInboxModule {}
