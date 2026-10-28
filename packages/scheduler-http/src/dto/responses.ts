import { DI } from '@spinajs/di';
import { SCHEMAS } from '@spinajs/validation';

export interface ISchedulerRunAccepted {
  runId: string;
  run?: unknown;
}

export const SchedulerRunAcceptedSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Scheduler run accepted',
  type: 'object',
  required: ['runId'],
  properties: {
    runId: { type: 'string', format: 'uuid' },
    run: { type: 'object', description: 'The run as it was when waiting ended, present only when the request waited' },
  },
};

// same registry @Schema writes to, keyed by the name the controllers' JSDoc uses ( see users-http dto/metadata-entry-schema.ts )
DI.register(SchedulerRunAcceptedSchema).asMapValue(SCHEMAS.key, 'ISchedulerRunAccepted');
