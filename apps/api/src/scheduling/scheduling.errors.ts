/** Typed failures of the appointment service (ADR 046). */
export class SlotTakenError extends Error {
  constructor() {
    super('The requested slot is no longer available');
    this.name = 'SlotTakenError';
  }
}

/** The slot is not offered by the engine (lead time, skills, hours, grid). */
export class SlotUnavailableError extends Error {
  constructor() {
    super('The requested time is not a bookable slot');
    this.name = 'SlotUnavailableError';
  }
}

export class SchedulingNotFoundError extends Error {
  constructor(public readonly entity: string) {
    super(`${entity} not found`);
    this.name = 'SchedulingNotFoundError';
  }
}

export class HoldExpiredError extends Error {
  constructor() {
    super('The hold has expired');
    this.name = 'HoldExpiredError';
  }
}

export class InvalidAppointmentStateError extends Error {
  constructor(public readonly status: string) {
    super(`Appointment is ${status}`);
    this.name = 'InvalidAppointmentStateError';
  }
}
