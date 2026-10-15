import { expect } from 'chai';
import {
  defineSchedule,
  FakeClock,
  RunContext,
  RunStepModel,
  Scheduler,
  ScheduledTask,
  SchedulerService,
  TriggeredBy,
} from '../../src/index.js';

export const JSON_ROUND_TRIP_SCHEDULE = 'json-round-trip';

/** Values whose JSON text Postgres / MySQL JSON columns would hand back already parsed. */
export const JSON_VALUES: Array<[string, unknown]> = [
  ['string', 'ok'],
  ['number-like string', '123'],
  ['number', 123],
  ['null', null],
  ['object', { a: 1, b: [true, 'x'] }],
  ['array', [1, 'two', null]],
];

const state: { value: unknown; resumedStep: unknown; resumedCheckpoint: unknown } = {
  value: undefined,
  resumedStep: undefined,
  resumedCheckpoint: undefined,
};

/** Attempt 1 stores the value as step result and checkpoint, then fails; attempt 2 resumes from both. */
class JsonRoundTripTask extends ScheduledTask {
  public async execute(ctx: RunContext) {
    if (ctx.attempt > 1) state.resumedCheckpoint = ctx.lastCheckpoint;
    const value = await ctx.step('value', () => state.value);
    if (ctx.attempt === 1) {
      await ctx.checkpoint(state.value);
      throw new Error('first attempt fails');
    }
    state.resumedStep = value;
    return value;
  }
}

export function defineJsonRoundTripSchedule(): void {
  defineSchedule(JsonRoundTripTask, JSON_ROUND_TRIP_SCHEDULE, {
    manual: true,
    resumable: true,
    retry: { attempts: 2, backoff: 'fixed', delay: '1s' },
  });
}

/** Run result, step results and checkpoint of every value read back through the service and a resume. */
export async function expectJsonRoundTrip(service: SchedulerService, s: Scheduler, clock: FakeClock): Promise<void> {
  const by: TriggeredBy = { kind: 'user', id: '1' };
  for (const [label, value] of JSON_VALUES) {
    Object.assign(state, { value, resumedStep: undefined, resumedCheckpoint: undefined });
    const { runId } = await service.runNow(JSON_ROUND_TRIP_SCHEDULE, { triggeredBy: by });
    await s.tickOnce();
    await s.idle();
    await clock.advance(1000);
    await s.tickOnce();
    await s.idle();

    const detail = await service.getRun(runId);
    expect(detail.status, label).to.eq('succeeded');
    expect(detail.result, label).to.deep.eq(value);
    expect(detail.checkpoint, label).to.deep.eq(value);
    expect(state.resumedStep, label).to.deep.eq(value);
    expect(state.resumedCheckpoint, label).to.deep.eq(value);
    const steps = await RunStepModel.where('RunId', runId).orderBy('Attempt');
    expect(
      steps.map((x) => [x.Attempt, x.Status, x.Result]),
      label,
    ).to.deep.eq([
      [1, 'succeeded', value],
      [2, 'skipped', value],
    ]);
    const page = await service.listRuns({ schedule: JSON_ROUND_TRIP_SCHEDULE });
    expect(page.items.find((r) => r.id === runId)?.result, label).to.deep.eq(value);
  }
}
