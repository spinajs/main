import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import {
  activeSchedulers,
  Clock,
  DbTimeSource,
  DefaultSchedulerService,
  FakeClock,
  RunInfo,
  RunModel,
  Schedule,
  ScheduledTask,
  Scheduler,
  SchedulerService,
  TimerHandle,
} from '@spinajs/scheduler';

import { asRole, bootRealHttp, req, stopHttp } from './common.js';

const SCHEDULE = 'http-run-now-wait';
const FLAKY = 'http-run-now-wait-flaky';
const WAIT_MS = 2000;

// declared at import, like the parity suite's schedules: the schedule registry of the first suite that boots stays in use
@Schedule(SCHEDULE, { manual: true })
export class HttpRunNowWaitTask extends ScheduledTask {
  public async execute() {
    return 'done';
  }
}

@Schedule(FLAKY, { manual: true, retry: { attempts: 2, delay: '1h' } })
export class HttpRunNowWaitFlakyTask extends ScheduledTask {
  public execute(): Promise<void> {
    return Promise.reject(new Error('upstream down'));
  }
}

/** Records timer delays, so a test can wait until the request armed its wait timer. */
class ObservedClock extends FakeClock {
  public readonly delays: number[] = [];

  public setTimeout(fn: () => void, ms: number): TimerHandle {
    this.delays.push(ms);
    return super.setTimeout(fn, ms);
  }
}

interface RunNowAnswer {
  status: number;
  body: { runId: string; run?: RunInfo };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs} ms`);
    await sleep(10);
  }
}

describe('scheduler-http: run now with wait in a process without a scheduler loop', function () {
  this.timeout(60000);

  let clock: ObservedClock;

  function post(schedule: string): { answer: () => RunNowAnswer | undefined; done: Promise<RunNowAnswer> } {
    let answer: RunNowAnswer | undefined;
    const done = req()
      .post(`scheduler/schedules/${schedule}/runs`)
      .set(asRole('scheduler-admin'))
      .send({ wait: true })
      .then((res) => (answer = { status: res.status, body: res.body as RunNowAnswer['body'] }));
    return { answer: () => answer, done };
  }

  /** The request has written its run and armed its wait timer. */
  async function waiting(request: ReturnType<typeof post>, schedule: string): Promise<void> {
    await until(async () => {
      const early = request.answer();
      if (early) throw new Error(`answered ${early.status} instead of waiting: ${JSON.stringify(early.body).slice(0, 200)}`);
      return (await RunModel.where('Schedule', schedule)).length === 1 && clock.delays.includes(WAIT_MS);
    });
  }

  /** Lets the hub poll the journal on clock time, staying inside the configured wait. */
  async function pollWithinWait(request: ReturnType<typeof post>): Promise<void> {
    for (let t = 0; t < WAIT_MS - 500 && !request.answer(); t += 100) {
      await clock.advance(100);
      await sleep(20);
    }
  }

  before(async () => {
    clock = new ObservedClock('2026-01-05T10:00:00.000Z');
    await bootRealHttp(
      {
        scheduler: { enabled: false, retention: { enabled: false } },
        // importing @spinajs/queue registers JobModel on this connection
        connections: [{ Driver: 'orm-driver-sqlite', Filename: ':memory:', Name: 'queue', Migration: { Table: 'orm_migrations' } }],
        config: {
          queue: { default: 'black-hole', routing: {}, connections: [{ name: 'black-hole', service: 'BlackHoleQueueClient' }] },
          'scheduler.http.runWaitTimeout': WAIT_MS,
        },
      },
      () => {
        DI.register(DefaultSchedulerService).as(SchedulerService);
        DI.register(() => clock).as(Clock);
        DI.register(() => clock.dbSource).as(DbTimeSource);
      },
    );
    await DI.resolve(SchedulerService);
  });

  after(() => stopHttp());

  afterEach(async () => {
    clock.delays.length = 0;
    for (const s of activeSchedulers()) await s.stop();
    await RunModel.truncate();
  });

  it('answers 202 with the unfinished run once the configured wait has passed', async () => {
    expect(activeSchedulers().some((s) => s.isStarted())).to.eq(false);
    const request = post(SCHEDULE);
    await waiting(request, SCHEDULE);

    await clock.advance(WAIT_MS - 500);
    await sleep(200);
    expect(request.answer(), 'answered before scheduler.http.runWaitTimeout').to.eq(undefined);

    await clock.advance(1000);
    const { status, body } = await request.done;
    expect(status).to.eq(202);
    expect(body.runId).to.be.a('string');
    expect(body.run).to.include({ id: body.runId, status: 'queued', finishedAt: null });
    expect((await RunModel.where('Id', body.runId)).map((r) => r.Status)).to.deep.eq(['queued']);
  });

  it('answers 200 with the finished run when another scheduler instance runs it within the wait', async () => {
    const request = post(SCHEDULE);
    await waiting(request, SCHEDULE);

    const worker = await DI.resolve(Scheduler, [{ replicaId: 'http-run-now-wait-worker', autoStart: false }]);
    await worker.tickOnce();
    await worker.idle();
    await pollWithinWait(request);

    const { status, body } = await request.done;
    expect(status).to.eq(200);
    expect(body.run).to.include({ id: body.runId, status: 'succeeded' });
    expect(body.run?.finishedAt).to.be.a('string');
  });

  it('answers 202 with a run waiting for its retry when the wait passes', async () => {
    const request = post(FLAKY);
    await waiting(request, FLAKY);

    const worker = await DI.resolve(Scheduler, [{ replicaId: 'http-run-now-wait-retry-worker', autoStart: false }]);
    await worker.tickOnce();
    await worker.idle();
    await pollWithinWait(request);
    expect(request.answer(), 'a retrying run is not finished').to.eq(undefined);

    await clock.advance(1000);
    const { status, body } = await request.done;
    expect(status).to.eq(202);
    expect(body.run).to.include({ id: body.runId, status: 'retrying', finishedAt: null });
  });
});
