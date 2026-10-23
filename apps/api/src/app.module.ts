import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { resolve } from 'node:path';
import { validateEnvironment } from './config/environment.js';
import { HealthController } from './health/health.controller.js';
import { TelegramModule } from './channels/telegram/telegram.module.js';
import { ConnectorsModule } from './connectors/connectors.module.js';
import { PersistenceModule } from './persistence/persistence.module.js';

@Module({
  imports: [
    TelegramModule,
    PersistenceModule,
    ConnectorsModule,
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: resolve(process.cwd(), '../../.env'),
      validate: validateEnvironment,
    }),
  ],
  controllers: [HealthController],
})
export class AppModule {}
