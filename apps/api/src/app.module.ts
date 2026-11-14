import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { resolve } from 'node:path';
import { validateEnvironment } from './config/environment.js';
import { HealthController } from './health/health.controller.js';
import { WebInboxModule } from './webinbox/webinbox.module.js';
import { AssistantToolsModule } from './webinbox/assistant-tools.module.js';
import { TelegramModule } from './channels/telegram/telegram.module.js';
import { InstagramModule } from './channels/instagram/instagram.module.js';
import { AgentModule } from './agent/agent.module.js';
import { ConnectorsModule } from './connectors/connectors.module.js';
import { BackgroundModule } from './background/background.module.js';
import { PersistenceModule } from './persistence/persistence.module.js';
import { PlatformModule } from './platform/platform.module.js';

@Module({
  imports: [
    TelegramModule,
    InstagramModule,
    WebInboxModule,
    AssistantToolsModule,
    BackgroundModule,
    PersistenceModule,
    ConnectorsModule,
    AgentModule,
    PlatformModule,
    ConfigModule.forRoot({
      isGlobal: true,
      // ENV_FILE lets an isolated run (e2e) use its own file instead of .env.
      envFilePath: process.env.ENV_FILE ?? resolve(process.cwd(), '../../.env'),
      validate: validateEnvironment,
    }),
  ],
  controllers: [HealthController],
})
export class AppModule {}
