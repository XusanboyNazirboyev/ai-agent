import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module.js';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { WebInboxModule } from '../webinbox/webinbox.module.js';
import { ClickPaymentsService } from './click-payments.service.js';
import {
  ClickCallbackController,
  ClickCheckoutController,
} from './click.controllers.js';
import {
  PaymeCallbackController,
  PaymeCheckoutController,
} from './payme.controllers.js';
import { PaymePaymentsService } from './payme-payments.service.js';

/** Subscription payments through Click (ADR 082). */
@Module({
  imports: [PersistenceModule, AccessModule, WebInboxModule],
  controllers: [
    ClickCheckoutController,
    ClickCallbackController,
    PaymeCheckoutController,
    PaymeCallbackController,
  ],
  providers: [ClickPaymentsService, PaymePaymentsService],
  exports: [ClickPaymentsService, PaymePaymentsService],
})
export class BillingModule {}
