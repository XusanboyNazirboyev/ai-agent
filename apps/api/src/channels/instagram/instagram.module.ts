import { Module } from '@nestjs/common';
import { PersistenceModule } from '../../persistence/persistence.module.js';
import { SecretsModule } from '../../secrets/secrets.module.js';
import { InstagramGraphClient } from './instagram-graph.js';
import { InstagramSender } from './instagram-sender.js';
import { InstagramWebhookController } from './instagram-webhook.controller.js';
import { InstagramWebhookService } from './instagram-webhook.service.js';

@Module({
  imports: [PersistenceModule, SecretsModule],
  controllers: [InstagramWebhookController],
  providers: [InstagramWebhookService, InstagramGraphClient, InstagramSender],
  exports: [InstagramGraphClient, InstagramSender],
})
export class InstagramModule {}
