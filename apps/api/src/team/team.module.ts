import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module.js';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { OperatorInviteService } from './operator-invite.service.js';
import { PasswordResetService } from './password-reset.service.js';

/**
 * Operator invites, password reset links and team rules (ADR 047 §5 and its
 * 2026-11-17 amendment); no controllers here.
 */
@Module({
  imports: [PersistenceModule, AccessModule],
  providers: [OperatorInviteService, PasswordResetService],
  exports: [OperatorInviteService, PasswordResetService],
})
export class TeamModule {}
