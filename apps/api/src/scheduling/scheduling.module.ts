import { Module } from '@nestjs/common';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { AppointmentService } from './appointment.service.js';

@Module({
  imports: [PersistenceModule],
  providers: [AppointmentService],
  exports: [AppointmentService],
})
export class SchedulingModule {}
