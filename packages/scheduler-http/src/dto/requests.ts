import { Schema } from '@spinajs/validation';
import type { ErrorGroupStatus, RunStatus, RunTrigger } from '@spinajs/scheduler';

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 500;

// Record keys make the compiler flag a value added to or removed from the core contract types
const RUN_STATUS_KEYS: Record<RunStatus, true> = { queued: true, running: true, succeeded: true, failed: true, retrying: true, dead: true, aborted: true, emitted: true, skipped: true, misfired: true };
const RUN_TRIGGER_KEYS: Record<RunTrigger, true> = { schedule: true, manual: true, retry: true, 'catch-up': true };
const ERROR_GROUP_STATUS_KEYS: Record<ErrorGroupStatus, true> = { open: true, resolved: true, ignored: true };

export const RUN_STATUSES = Object.keys(RUN_STATUS_KEYS) as RunStatus[];
export const RUN_TRIGGERS = Object.keys(RUN_TRIGGER_KEYS) as RunTrigger[];
export const ERROR_GROUP_STATUSES = Object.keys(ERROR_GROUP_STATUS_KEYS) as ErrorGroupStatus[];

export const RUN_ID_SCHEMA = { type: 'string', format: 'uuid' };
export const LAST_EVENT_ID_SCHEMA = { type: 'string', pattern: '^\\d+$' };

@Schema({
  $id: 'scheduler.http.runNow',
  type: 'object',
  additionalProperties: false,
  properties: {
    params: { type: 'object', description: 'Parameters, validated against the schedule params schema' },
    force: { type: 'boolean', description: 'Queue behind a run in progress instead of answering 409' },
    wait: { type: 'boolean', description: 'Hold the request until the run ends' },
  },
})
export class RunNowDto {
  public params?: Record<string, unknown>;
  public force?: boolean;
  public wait?: boolean;

  constructor(data: Partial<RunNowDto> = {}) {
    Object.assign(this, data);
  }
}

@Schema({
  $id: 'scheduler.http.retryRun',
  type: 'object',
  additionalProperties: false,
  properties: {
    fromStep: { type: 'string', minLength: 1, description: 'Start at this step instead of the first incomplete one' },
    params: { type: 'object' },
    resume: { type: 'boolean', description: 'Reuse the last checkpoint and skip completed steps; defaults to the schedule resumable option' },
  },
})
export class RetryRunDto {
  public fromStep?: string;
  public params?: Record<string, unknown>;
  public resume?: boolean;

  constructor(data: Partial<RetryRunDto> = {}) {
    Object.assign(this, data);
  }
}

@Schema({
  $id: 'scheduler.http.retryFailed',
  type: 'object',
  additionalProperties: false,
  required: ['since'],
  properties: {
    since: { type: 'string', format: 'date-time', description: 'Retry failed and dead runs that finished at or after this instant' },
  },
})
export class RetryFailedDto {
  public since: string;

  constructor(data: Partial<RetryFailedDto> = {}) {
    Object.assign(this, data);
  }
}

@Schema({
  $id: 'scheduler.http.pause',
  type: 'object',
  additionalProperties: false,
  properties: {
    hard: { type: 'boolean', description: 'Also refuse manual runs while paused' },
  },
})
export class PauseDto {
  public hard?: boolean;

  constructor(data: Partial<PauseDto> = {}) {
    Object.assign(this, data);
  }
}

@Schema({
  $id: 'scheduler.http.errorStatus',
  type: 'object',
  additionalProperties: false,
  required: ['status'],
  properties: {
    status: { type: 'string', enum: ERROR_GROUP_STATUSES },
  },
})
export class ErrorStatusDto {
  public status: ErrorGroupStatus;

  constructor(data: Partial<ErrorStatusDto> = {}) {
    Object.assign(this, data);
  }
}
