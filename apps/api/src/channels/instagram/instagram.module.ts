import { Module } from '@nestjs/common';
import { PersistenceModule } from '../../persistence/persistence.module.js';
import { SecretsModule } from '../../secrets/secrets.module.js';
import { InstagramGraphClient } from './instagram-graph.js';
import { InstagramSender } from './instagram-sender.js';
import { InstagramCommentReplyService } from './instagram-comment-reply.service.js';
import { FacebookSender } from '../facebook/facebook-sender.js';
import { FacebookWebhookController } from '../facebook/facebook-webhook.controller.js';
import { InstagramWebhookController } from './instagram-webhook.controller.js';
import { InstagramWebhookService } from './instagram-webhook.service.js';

@Module({
  imports: [PersistenceModule, SecretsModule],
  controllers: [InstagramWebhookController, FacebookWebhookController],
  providers: [
    InstagramWebhookService,
    InstagramGraphClient,
    InstagramSender,
    InstagramCommentReplyService,
    FacebookSender,
  ],
  exports: [
    InstagramGraphClient,
    InstagramSender,
    InstagramCommentReplyService,
    FacebookSender,
  ],
})
export class InstagramModule {}
