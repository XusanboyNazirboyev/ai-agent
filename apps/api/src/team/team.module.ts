import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module.js';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { OperatorInviteService } from './operator-invite.service.js';

/** Operator invites and team rules (ADR 047 §5); no controllers here. */
@Module({
  imports: [PersistenceModule, AccessModule],
  providers: [OperatorInviteService],
  exports: [OperatorInviteService],
})
export class TeamModule {}
