import { Module } from '@nestjs/common';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { AppointmentService } from './appointment.service.js';
import { SchedulingActionsService } from './scheduling-actions.service.js';

@Module({
  imports: [PersistenceModule],
  providers: [AppointmentService, SchedulingActionsService],
  exports: [AppointmentService, SchedulingActionsService],
})
export class SchedulingModule {}
