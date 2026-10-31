import { Module } from '@nestjs/common';
import { InstagramWebhookController } from './instagram-webhook.controller.js';

@Module({
  controllers: [InstagramWebhookController],
})
export class InstagramModule {}
