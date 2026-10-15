import { expect } from 'chai';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import { DI } from '@spinajs/di';
import { Mutex } from '@spinajs/threading';
import { Task, __task, __task_history } from '@spinajs/tasks';
import {
  currentRunContext,
  FakeClock,
  loadTaskMethodLookup,
  RunStepModel,
  Scheduler,
  ScheduleRegistry,
  ScheduleValidationError,
} from '../src/index.js';
import { bootTestEnv } from './support/env.js';
import { getRun, journal, queuedRun } from './support/fixtures.js';

chai.use(chaiAsPromised);

let calls = 0;
let failFirst = false;
let seenParams: unknown;

export class DigestJobs {
  @Task('send-digest', 'Sends the daily digest')
  public async sendDigest() {
    calls++;
    seenParams = currentRunContext()?.params;
    if (failFirst && calls === 1) throw new Error('smtp down');
    await currentRunContext()?.step('render', () => 1);
    return { sent: 3 };
  }
}

describe('scheduling @Task methods', () => {
  let clock: FakeClock;
  const entry = (extra: object = {}) => ({ name: 'digest', task: 'send-digest', manual: true, ...extra });

  /** Boots, lets the caller register doubles, queues one run of 'digest' and drives it. */
  async function runDigest(options: { entry?: object; run?: object; before?: () => void } = {}) {
    ({ clock } = await bootTestEnv({ now: '2026-01-05T10:00:00Z', scheduler: { schedules: [entry(options.entry)] } }));
    options.before?.();
    const scheduler = await DI.resolve(Scheduler, [{ replicaId: 'r1', autoStart: false }]);
    const run = await queuedRun('digest', clock.now(), options.run);
    await scheduler.tickOnce();
    await scheduler.idle();
    return { scheduler, run };
  }

  beforeEach(() => {
    calls = 0;
    failFirst = false;
    seenParams = undefined;
  });
  afterEach(() => sinon.restore());

  it('resolves a config task reference to the @Task method', async () => {
    await bootTestEnv({ scheduler: { schedules: [entry()] } });
    const def = (await DI.resolve(ScheduleRegistry)).get('digest');
    expect(def.task.name).to.eq('Task:send-digest');
  });

  it('fails the boot on an unknown task name', async () => {
    await bootTestEnv({ scheduler: { schedules: [{ name: 'ghost', task: 'no-such-task', every: '1m' }] } });
    await expect(DI.resolve(ScheduleRegistry)).to.be.rejectedWith(
      ScheduleValidationError,
      /ghost.*unknown task 'no-such-task'/,
    );
  });

  it('tracks the run, its steps and its result in __scheduler_run', async () => {
    const { run } = await runDigest();
    const row = await getRun(run.Id);
    expect(row.Status).to.eq('succeeded');
    expect(row.Result).to.deep.eq({ sent: 3 });
    expect((await RunStepModel.where('RunId', run.Id)).map((s) => s.Name)).to.deep.eq(['render']);
    expect((await journal(run.Id)).map((e) => e.type)).to.include.members(['status', 'step-start', 'step-end']);
  });

  it('gives the method the run params through currentRunContext() and nothing outside a run', async () => {
    await runDigest({ run: { Params: { to: 'ops' } } });
    expect(seenParams).to.deep.eq({ to: 'ops' });
    expect(currentRunContext()).to.eq(undefined);
  });

  it('still writes the legacy __task_history row', async () => {
    await runDigest();
    const task = (await __task.where('Name', 'send-digest').first())!;
    expect(task.State).to.eq('stopped');
    const history = await __task_history.where('TaskId', task.Id);
    expect(history).to.have.length(1);
    expect(history[0].Result).to.deep.eq({ sent: 3 });
  });

  it('does not take the @Task mutex: the scheduler lease is the only lock', async () => {
    const mutex = {
      acquire: sinon.stub().rejects(new Error('the task mutex must not be taken')),
      release: sinon.stub().rejects(new Error('the task mutex must not be released')),
      renew: sinon.stub().resolves(false),
    };
    const { run } = await runDigest({ before: () => DI.register(() => mutex).as(Mutex) });
    expect((await getRun(run.Id)).Status).to.eq('succeeded');
    expect(mutex.acquire.called).to.eq(false);
    expect(mutex.release.called).to.eq(false);
    expect(mutex.renew.called).to.eq(false);
  });

  it('reports a failing method to retries and writes history for every attempt', async () => {
    failFirst = true;
    const { scheduler, run } = await runDigest({
      entry: { retry: { attempts: 2, delay: '1s' } },
      run: { MaxAttempts: 2 },
    });
    expect((await getRun(run.Id)).Status).to.eq('retrying');
    expect((await getRun(run.Id)).Error).to.include({ message: 'smtp down' });

    clock.set(clock.now() + 1000);
    await scheduler.tickOnce();
    await scheduler.idle();

    expect(await getRun(run.Id)).to.include({ Status: 'succeeded', Attempt: 2 });
    const results = (await __task_history.all()).map((h) => h.Result);
    expect(results[0]).to.include({ error: true });
    expect(results[1]).to.deep.eq({ sent: 3 });
  });
});

describe('loadTaskMethodLookup', () => {
  const failing = (message: string, code?: string) => () =>
    Promise.reject(Object.assign(new Error(message), code ? { code } : {}));

  it('finds no @Task methods when @spinajs/tasks is not installed (ESM and CJS errors)', async () => {
    const esm = failing("Cannot find package '@spinajs/tasks' imported from /app/scheduler.js", 'ERR_MODULE_NOT_FOUND');
    const cjs = failing("Cannot find module '@spinajs/tasks'\nRequire stack:\n- /app/scheduler.js", 'MODULE_NOT_FOUND');
    expect((await loadTaskMethodLookup(esm))('send-digest')).to.deep.eq([]);
    expect((await loadTaskMethodLookup(cjs))('send-digest')).to.deep.eq([]);
  });

  it('rethrows any other failure to load @spinajs/tasks', async () => {
    await expect(loadTaskMethodLookup(failing('broken module'))).to.be.rejectedWith('broken module');
    const missingInside = failing(
      "Cannot find package 'luxon' imported from /app/node_modules/@spinajs/tasks/lib/mjs/decorators.js",
      'ERR_MODULE_NOT_FOUND',
    );
    await expect(loadTaskMethodLookup(missingInside)).to.be.rejectedWith(/luxon/);
  });
});
