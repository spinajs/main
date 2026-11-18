import { expect } from 'chai';
import { DI } from '@spinajs/di';
import {
  defineSchedule,
  FakeClock,
  RunContext,
  RunDetail,
  Scheduler,
  SchedulerRunShowCommand,
  SchedulerService,
  ScheduledTask,
  undefineSchedule,
} from '../src/index.js';
import { bootTestEnv } from './support/env.js';
import { captureConsole } from './support/console.js';
import { queuedRun } from './support/fixtures.js';

class StepResultsTask extends ScheduledTask {
  public async execute(ctx: RunContext) {
    await ctx.step('forecast', () => ({ hours: 48, source: 'met' }));
    await ctx.step('token', () => ({ token: 'not for the API' }), { persistResult: false });
    await ctx.step('dump', () => 'x'.repeat(200));
    await ctx.step('store', () => undefined);
    await ctx.step('plan', () => {
      throw new Error('planner not ready');
    });
  }
}

const EXPECTED = [
  ['forecast', 'succeeded', { hours: 48, source: 'met' }, true],
  ['token', 'succeeded', null, false],
  ['dump', 'succeeded', null, false],
  ['store', 'succeeded', null, true],
  ['plan', 'failed', null, false],
];
const stepsOf = (detail: RunDetail) => detail.steps.map((x) => [x.name, x.status, x.result, x.resultStored]);

describe('step results in run details', () => {
  let clock: FakeClock;
  let runId: string;

  beforeEach(async () => {
    defineSchedule(StepResultsTask, 'step-results', { manual: true });
    ({ clock } = await bootTestEnv({ now: '2026-01-05T10:00:00Z', scheduler: { maxStepResultBytes: 100 } }));
    const s = await DI.resolve(Scheduler, [{ replicaId: 'r1', autoStart: false }]);
    runId = (await queuedRun('step-results', clock.now())).Id;
    await s.tickOnce();
    await s.idle();
  });
  afterEach(() => undefineSchedule('step-results'));

  it('returns the stored result of each step and tells a dropped value from a step that returned nothing', async () => {
    expect(stepsOf(await (await DI.resolve(SchedulerService)).getRun(runId))).to.deep.eq(EXPECTED);
  });

  it('prints them with scheduler:run:show --json', async () => {
    const out = captureConsole();
    try {
      await (await DI.resolve(SchedulerRunShowCommand)).execute(runId, { json: true });
    } finally {
      out.restore();
    }
    expect(stepsOf(out.json<RunDetail>())).to.deep.eq(EXPECTED);
  });
});
