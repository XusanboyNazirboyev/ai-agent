import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { resolve } from 'node:path';
import { validateEnvironment } from './config/environment.js';
import { HealthController } from './health/health.controller.js';
import { WebInboxModule } from './webinbox/webinbox.module.js';
import { TelegramModule } from './channels/telegram/telegram.module.js';
import { AgentModule } from './agent/agent.module.js';
import { ConnectorsModule } from './connectors/connectors.module.js';
import { BackgroundModule } from './background/background.module.js';
import { PersistenceModule } from './persistence/persistence.module.js';

@Module({
  imports: [
    TelegramModule,
    WebInboxModule,
    BackgroundModule,
    PersistenceModule,
    ConnectorsModule,
    AgentModule,
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: resolve(process.cwd(), '../../.env'),
      validate: validateEnvironment,
    }),
  ],
  controllers: [HealthController],
})
export class AppModule {}
