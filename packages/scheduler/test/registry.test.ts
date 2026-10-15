import { expect } from 'chai';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { DI } from '@spinajs/di';
import { DataValidator } from '@spinajs/validation';
import { defineSchedule, SCHEDULER_CONFIGURATION_SCHEMA, SCHEDULER_DEFAULTS, ScheduledTask, ScheduleNotFound, ScheduleRegistry, ScheduleValidationError, undefineSchedule } from '../src/index.js';
import { bootTestEnv } from './support/env.js';

chai.use(chaiAsPromised);

class Nightly extends ScheduledTask {}

describe('ScheduleRegistry', () => {
  beforeEach(() => defineSchedule(Nightly, 'nightly', { cron: '0 2 * * *' }));
  afterEach(() => undefineSchedule('nightly'));

  it('merges decorators and config schedules', async () => {
    await bootTestEnv({ scheduler: { schedules: [{ name: 'nightly', cron: '0 3 * * *' }, { name: 'nightly-copy', task: 'Nightly', every: '1h' }] } });
    const registry = await DI.resolve(ScheduleRegistry);
    expect(registry.get('nightly').spec.expression).to.eq('0 3 * * *');
    expect(registry.get('nightly-copy').task).to.eq(Nightly);
    expect(registry.find('missing')).to.eq(undefined);
    expect(() => registry.get('missing')).to.throw(ScheduleNotFound);
  });

  it('fails the boot on an invalid schedule', async () => {
    await bootTestEnv({ scheduler: { schedules: [{ name: 'nightly', cron: 'garbage' }] } });
    await expect(DI.resolve(ScheduleRegistry)).to.be.rejectedWith(ScheduleValidationError);
  });

  it('ships defaults that satisfy the configuration schema', async () => {
    await bootTestEnv();
    const validator = await DI.resolve(DataValidator);
    // $id and the custom keyword are only meaningful to @spinajs/configuration's own ajv instance
    const { $id, $configurationModule, ...schema } = SCHEDULER_CONFIGURATION_SCHEMA as Record<string, unknown>;
    const [ok, errors] = validator.tryValidate(schema, SCHEDULER_DEFAULTS);
    expect(errors).to.eq(null);
    expect(ok).to.eq(true);
    expect($id).to.be.a('string');
    expect($configurationModule).to.eq('scheduler');
  });
});
