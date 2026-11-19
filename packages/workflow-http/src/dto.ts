import { Schema } from '@spinajs/validation';
import { WORKFLOW_STATUSES } from '@spinajs/workflow';

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 500;

const status = `(${WORKFLOW_STATUSES.join('|')})`;
/** `status=running,waiting`. */
export const STATUS_LIST_SCHEMA = { type: 'string', pattern: `^${status}(,${status})*$` };
export const INSTANCE_ID_SCHEMA = { type: 'string', minLength: 1, maxLength: 128 };
export const WORKFLOW_NAME_SCHEMA = { type: 'string', minLength: 1, maxLength: 128 };
// '#' ends the name in a wait key and '*' marks several names (identifier.ts)
export const SIGNAL_NAME_SCHEMA = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[^#*]+$' };

@Schema({
  $id: 'workflow.http.start',
  type: 'object',
  additionalProperties: false,
  required: ['workflow'],
  properties: {
    workflow: WORKFLOW_NAME_SCHEMA,
    input: { description: 'Workflow input, any JSON value' },
    id: { ...INSTANCE_ID_SCHEMA, description: 'Instance id; a repeated start with the same id returns the existing instance' },
    version: { type: 'integer', minimum: 1 },
  },
})
export class StartWorkflowDto {
  public workflow: string;
  public input?: unknown;
  public id?: string;
  public version?: number;

  constructor(data: Partial<StartWorkflowDto> = {}) {
    Object.assign(this, data);
  }
}

@Schema({
  $id: 'workflow.http.signal',
  type: 'object',
  additionalProperties: false,
  properties: {
    payload: { description: 'Signal payload, any JSON value' },
    dedupKey: { type: 'string', minLength: 1, maxLength: 128, description: 'A second signal with the same key is not stored' },
  },
})
export class SignalDto {
  public payload?: unknown;
  public dedupKey?: string;

  constructor(data: Partial<SignalDto> = {}) {
    Object.assign(this, data);
  }
}

@Schema({
  $id: 'workflow.http.cancel',
  type: 'object',
  additionalProperties: false,
  properties: { reason: { type: 'string', minLength: 1, maxLength: 64 } },
})
export class CancelDto {
  public reason?: string;

  constructor(data: Partial<CancelDto> = {}) {
    Object.assign(this, data);
  }
}
