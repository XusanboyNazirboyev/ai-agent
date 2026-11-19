import { Module } from '@nestjs/common';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { PublicPlansController } from './public-plans.controller.js';

/** Endpoints without a session (ADR 080). */
@Module({
  imports: [PersistenceModule],
  controllers: [PublicPlansController],
})
export class PublicModule {}
