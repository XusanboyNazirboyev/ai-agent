import { Module } from '@nestjs/common';
import { ConnectorsModule } from '../connectors/connectors.module.js';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { LeadSyncService } from './lead-sync.service.js';
import { LeadService } from './lead.service.js';
import { ShownOffersService } from './shown-offers.service.js';

@Module({
  imports: [PersistenceModule, ConnectorsModule],
  providers: [LeadService, LeadSyncService, ShownOffersService],
  exports: [LeadService, LeadSyncService, ShownOffersService],
})
export class LeadsModule {}
