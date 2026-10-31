import { Module } from '@nestjs/common';
import { PersistenceModule } from '../../persistence/persistence.module.js';
import { InstagramWebhookController } from './instagram-webhook.controller.js';
import { InstagramWebhookService } from './instagram-webhook.service.js';

@Module({
  imports: [PersistenceModule],
  controllers: [InstagramWebhookController],
  providers: [InstagramWebhookService],
})
export class InstagramModule {}
