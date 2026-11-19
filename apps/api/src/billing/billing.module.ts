import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module.js';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { WebInboxModule } from '../webinbox/webinbox.module.js';
import { ClickPaymentsService } from './click-payments.service.js';
import {
  ClickCallbackController,
  ClickCheckoutController,
} from './click.controllers.js';

/** Subscription payments through Click (ADR 082). */
@Module({
  imports: [PersistenceModule, AccessModule, WebInboxModule],
  controllers: [ClickCheckoutController, ClickCallbackController],
  providers: [ClickPaymentsService],
  exports: [ClickPaymentsService],
})
export class BillingModule {}
