import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { Clock, DbTimeSource, DefaultSchedulerService, FakeClock, RunContext, Schedule, ScheduledTask, Scheduler, SchedulerService } from '@spinajs/scheduler';

import { asRole, bootRealHttp, req, stopHttp } from './common.js';

const SCHEDULE = 'http-step-results';

// declared at import, like the parity suite's schedules: the schedule registry of the first suite that boots stays in use
@Schedule(SCHEDULE, { manual: true })
export class HttpStepResultsTask extends ScheduledTask {
  public async execute(ctx: RunContext) {
    await ctx.step('forecast', () => ({ hours: 48 }));
    await ctx.step('token', () => ({ token: 'secret' }), { persistResult: false });
    await ctx.step('dump', () => 'x'.repeat(70_000));
  }
}

describe('scheduler-http: step results', function () {
  this.timeout(60000);

  const clock = new FakeClock('2026-01-05T10:00:00.000Z');
  let scheduler: Scheduler;

  before(async () => {
    await bootRealHttp(
      {
        scheduler: { enabled: false, retention: { enabled: false } },
        // importing @spinajs/queue registers JobModel on this connection
        connections: [{ Driver: 'orm-driver-sqlite', Filename: ':memory:', Name: 'queue', Migration: { Table: 'orm_migrations' } }],
        config: { queue: { default: 'black-hole', routing: {}, connections: [{ name: 'black-hole', service: 'BlackHoleQueueClient' }] } },
      },
      () => {
        DI.register(DefaultSchedulerService).as(SchedulerService);
        DI.register(() => clock).as(Clock);
        DI.register(() => clock.dbSource).as(DbTimeSource);
      },
    );
    await DI.resolve(SchedulerService);
    scheduler = await DI.resolve(Scheduler, [{ replicaId: 'http-step-results', autoStart: false }]);
  });

  after(async () => {
    await scheduler?.stop();
    await stopHttp();
  });

  it('returns each step result in the run detail to a scheduler:read caller', async () => {
    const accepted = await req().post(`scheduler/schedules/${SCHEDULE}/runs`).set(asRole('scheduler-admin')).send({});
    expect(accepted).to.have.status(202);
    const { runId } = accepted.body as { runId: string };
    await scheduler.tickOnce();
    await scheduler.idle();

    const res = await req().get(`scheduler/runs/${runId}`).set(asRole('scheduler-reader'));

    expect(res).to.have.status(200);
    const { steps } = res.body as { steps: Array<{ name: string; result: unknown; resultStored: boolean }> };
    expect(steps.map((s) => [s.name, s.result, s.resultStored])).to.deep.equal([
      ['forecast', { hours: 48 }, true],
      ['token', null, false],
      ['dump', null, false],
    ]);
  });
});
