import { describe, expect, it } from 'vitest';
import { HealthController } from './health.controller.js';

describe('HealthController', () => {
  it('reports that the process is healthy', () => {
    expect(new HealthController().getHealth()).toEqual({ status: 'ok' });
  });
});
