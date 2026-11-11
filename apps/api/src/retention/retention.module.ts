import { Module } from '@nestjs/common';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { ContactErasureService } from './contact-erasure.service.js';
import { RetentionService } from './retention.service.js';

@Module({
  imports: [PersistenceModule],
  providers: [RetentionService, ContactErasureService],
  exports: [RetentionService, ContactErasureService],
})
export class RetentionModule {}
