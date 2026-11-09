import { DomainPackSchema, type DomainPack } from '@agentcore/shared';
import { EDUCATION_PACK } from '../../packs/education/education.pack.js';

/** Test fixture: a pack that opts in to the scheduling tools (ADR 046). */
export const SCHEDULING_TEST_PACK: DomainPack = DomainPackSchema.parse({
  ...EDUCATION_PACK,
  key: 'scheduling-test',
  tools: [
    ...EDUCATION_PACK.tools,
    'find_slots',
    'book_slot',
    'cancel_booking',
    'reschedule_booking',
  ],
});
