import { Module } from '@nestjs/common';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { SecretsModule } from '../secrets/secrets.module.js';
import { MfaService } from './mfa.service.js';

/** Second factor shared by tenant operators and platform admins (ADR 048). */
@Module({
  imports: [PersistenceModule, SecretsModule],
  providers: [MfaService],
  exports: [MfaService],
})
export class MfaModule {}
