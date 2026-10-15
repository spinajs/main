import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DataValidator } from '@spinajs/validation';
import { InvalidRunState, SchedulePaused } from '@spinajs/scheduler';

import { ErrorStatusDto, LAST_EVENT_ID_SCHEMA, PauseDto, RetryFailedDto, RetryRunDto, RUN_ID_SCHEMA, RUN_STATUSES, RUN_TRIGGERS, RunNowDto } from '../src/dto/requests.js';
import { SchedulerConflict } from '../src/errors.js';
import '../src/dto/responses.js';

class EmptyConfiguration extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();
    this.Config = { logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'error', target: 'Empty' }] } };
  }
}

describe('scheduler-http dto', () => {
  let validator: DataValidator;

  before(async () => {
    DI.register(EmptyConfiguration).as(Configuration);
    await DI.resolve(Configuration);
    validator = await DI.resolve(DataValidator);
  });

  const valid = (type: object, data: unknown) => validator.tryValidate(validator.extractSchema(type), data as object)[0];
  const validAgainst = (schema: object, data: unknown) => validator.tryValidate(schema, data as object)[0];

  it('accepts an empty run-now body and the documented fields', () => {
    expect(valid(RunNowDto, {})).to.eq(true);
    expect(valid(RunNowDto, { params: { file: 'rates.csv' }, force: true, wait: false })).to.eq(true);
  });

  it('rejects unknown and mistyped run-now fields', () => {
    expect(valid(RunNowDto, { forse: true })).to.eq(false);
    expect(valid(RunNowDto, { params: 'file=x' })).to.eq(false);
    expect(valid(RunNowDto, { wait: 'maybe' })).to.eq(false);
  });

  it('validates retry and pause bodies', () => {
    expect(valid(RetryRunDto, { fromStep: 'poll forges', resume: true, params: {} })).to.eq(true);
    expect(valid(RetryRunDto, { fromStep: '' })).to.eq(false);
    expect(valid(RetryFailedDto, { since: '2026-10-01T00:00:00.000Z' })).to.eq(true);
    expect(valid(RetryFailedDto, {})).to.eq(false);
    expect(valid(RetryFailedDto, { since: 'yesterday' })).to.eq(false);
    expect(valid(PauseDto, { hard: true })).to.eq(true);
    expect(valid(PauseDto, { soft: true })).to.eq(false);
  });

  it('requires a known error-group status', () => {
    expect(valid(ErrorStatusDto, { status: 'resolved' })).to.eq(true);
    expect(valid(ErrorStatusDto, {})).to.eq(false);
    expect(valid(ErrorStatusDto, { status: 'closed' })).to.eq(false);
  });

  it('lists every run status and trigger of the core contract', () => {
    expect(RUN_STATUSES).to.have.members(['queued', 'running', 'succeeded', 'failed', 'retrying', 'dead', 'aborted', 'emitted', 'skipped', 'misfired']);
    expect(RUN_TRIGGERS).to.have.members(['schedule', 'manual', 'retry', 'catch-up']);
  });

  it('checks run ids and Last-Event-ID values', () => {
    expect(validAgainst(RUN_ID_SCHEMA, '11111111-1111-4111-8111-111111111111')).to.eq(true);
    expect(validAgainst(RUN_ID_SCHEMA, 'not-a-uuid')).to.eq(false);
    expect(validAgainst(LAST_EVENT_ID_SCHEMA, '42')).to.eq(true);
    expect(validAgainst(LAST_EVENT_ID_SCHEMA, 'abc')).to.eq(false);
  });

  it('maps the InvalidOperation-based scheduler errors to 409', () => {
    const map = DI.get<Map<string, unknown>>('__http_error_map__')!;

    expect(map.get(InvalidRunState.name)).to.eq(SchedulerConflict);
    expect(map.get(SchedulePaused.name)).to.eq(SchedulerConflict);
  });

  it('registers the run-accepted response schema under its documented name', () => {
    const schemas = DI.get<Map<string, any>>('__schemas__')!;

    expect(schemas.get('ISchedulerRunAccepted').required).to.deep.equal(['runId']);
  });
});
