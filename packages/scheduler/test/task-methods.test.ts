import { expect } from 'chai';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import { DI } from '@spinajs/di';
import {
  currentRunContext,
  FakeClock,
  findTaskMethods,
  loadTaskMethodLookup,
  registerTaskMethod,
  RunStepModel,
  RunTaskFn,
  Scheduler,
  ScheduleRegistry,
  ScheduleValidationError,
  taskMethodSchedule,
  TaskMethodDeclaration,
} from '../src/index.js';
import { bootTestEnv } from './support/env.js';
import { getRun, journal, queuedRun } from './support/fixtures.js';

chai.use(chaiAsPromised);

let calls = 0;
let failFirst = false;
let seenParams: unknown;

let constructedIn: unknown = 'never constructed';
let staticThis: unknown;

export class DigestJobs {
  constructor() {
    constructedIn = currentRunContext();
  }

  public async sendDigest() {
    calls++;
    seenParams = currentRunContext()?.params;
    if (failFirst && calls === 1) throw new Error('smtp down');
    await currentRunContext()?.step('render', () => 1);
    return { sent: 3 };
  }
}

export class ReportJobs {
  public static async sendReport() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    staticThis = this;
    await currentRunContext()?.step('collect', () => 1);
    return { rows: 2 };
  }
}

/** What the `@spinajs/tasks` shim registers for a `@Task` method, without the package. */
interface FakeTaskDecl extends TaskMethodDeclaration {
  method: (...args: unknown[]) => Promise<unknown>;
}
const runTask = sinon.spy(((decl, self, args) => decl.method.apply(self, args)) as RunTaskFn<FakeTaskDecl>);
const declare = (decl: FakeTaskDecl) => registerTaskMethod(decl.name, taskMethodSchedule(decl, runTask));
declare({
  name: 'send-digest',
  target: DigestJobs,
  isStatic: false,
  method(this: DigestJobs) {
    return this.sendDigest();
  },
});
declare({
  name: 'send-report-static',
  target: ReportJobs,
  isStatic: true,
  method(this: typeof ReportJobs) {
    return this.sendReport();
  },
});

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
    runTask.resetHistory();
    calls = 0;
    failFirst = false;
    seenParams = undefined;
    constructedIn = 'never constructed';
    staticThis = undefined;
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

  it('resolves the @Task class outside the run context', async () => {
    await runDigest();
    expect(constructedIn).to.not.eq('never constructed');
    expect(constructedIn).to.eq(undefined);
  });

  it('runs a static @Task method with its class as this', async () => {
    const { run } = await runDigest({ entry: { task: 'send-report-static' } });
    const row = await getRun(run.Id);
    expect(row.Status).to.eq('succeeded');
    expect(row.Result).to.deep.eq({ rows: 2 });
    expect(staticThis).to.eq(ReportJobs);
    expect((await RunStepModel.where('RunId', run.Id)).map((s) => s.Name)).to.deep.eq(['collect']);
  });

  it('gives the method the run params through currentRunContext() and nothing outside a run', async () => {
    await runDigest({ run: { Params: { to: 'ops' } } });
    expect(seenParams).to.deep.eq({ to: 'ops' });
    expect(currentRunContext()).to.eq(undefined);
  });

  it('runs the method through the registered runTask without the task lock and rethrowing', async () => {
    await runDigest();
    expect(runTask.calledOnce).to.eq(true);
    expect(runTask.firstCall.args[3]).to.deep.eq({ lock: false, rethrow: true });
  });

  it('reports a failing method to retries', async () => {
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
    expect(runTask.callCount).to.eq(2);
  });
});

describe('task method registry', () => {
  class Adapter {}

  it('finds every adapter registered under a task name until it is unregistered', async () => {
    const a = Adapter as never;
    const undo = registerTaskMethod('registry-probe', a);
    expect(findTaskMethods('registry-probe')).to.deep.eq([a]);
    expect((await loadTaskMethodLookup())('registry-probe')).to.deep.eq([a]);
    undo();
    expect(findTaskMethods('registry-probe')).to.deep.eq([]);
  });
});
