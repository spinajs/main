import { DI } from '@spinajs/di';
import { FakeClock, Scheduler, SchedulerService, undefineSchedule } from '../src/index.js';
import { bootTestEnv } from './support/env.js';
import {
  defineJsonRoundTripSchedule,
  expectJsonRoundTrip,
  JSON_ROUND_TRIP_SCHEDULE,
} from './support/json-round-trip.js';

describe('JSON payload columns', () => {
  let clock: FakeClock;

  beforeEach(async () => {
    defineJsonRoundTripSchedule();
    ({ clock } = await bootTestEnv({ now: '2026-01-05T10:00:30Z' }));
  });
  afterEach(() => undefineSchedule(JSON_ROUND_TRIP_SCHEDULE));

  it('round-trips run results, step results and checkpoints of every JSON shape', async () => {
    const s = await DI.resolve(Scheduler, [{ replicaId: 'r1', autoStart: false }]);
    await expectJsonRoundTrip(await DI.resolve(SchedulerService), s, clock);
  });
});
