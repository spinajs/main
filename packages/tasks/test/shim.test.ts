import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { expect } from 'chai';
import * as sinon from 'sinon';

import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import '@spinajs/log';
import { MigrationTransactionMode, Orm } from '@spinajs/orm';
import '@spinajs/orm-sqlite';
import { QueueService } from '@spinajs/queue';
import {
  Clock,
  DbTimeSource,
  FakeClock,
  LeaseStore,
  RunModel,
  Scheduler,
  ScheduleRegistry,
  SchedulerService,
} from '@spinajs/scheduler';

import { __task, __task_history } from '../src/index.js';
import { DEFAULT_TASK_OPTIONS, getTaskDeclarations, runTask } from '../src/decorators.js';
import { TaskSuccess } from '../src/events/TaskSuccess.js';
import { TaskFailed } from '../src/events/TaskFailed.js';
import { TestTask } from './Tasks/TestTask.js';
import { closeTestTask2Gate, TestTask2, TestTaskStacking, testTask2Gate } from './Tasks/TestTask2.js';
import { TestTask3 } from './Tasks/TestTask3.js';
import { TestTaskCrash } from './Tasks/TestTaskCrash.js';
import { TestTaskFailing } from './Tasks/TestTaskFailing.js';
import { TestTaskNoOptions } from './Tasks/TestTaskNoOptions.js';
import { TestTaskThrowsNull } from './Tasks/TestTaskThrowsNull.js';
import { TestTaskValue } from './Tasks/TestTaskValue.js';

chai.use(chaiAsPromised);

let overrides: Record<string, unknown> = {};

const sqlite = (name: string) => ({
  Driver: 'orm-driver-sqlite',
  Filename: ':memory:',
  Name: name,
  Migration: { OnStartup: true, Table: 'orm_migrations', Transaction: { Mode: MigrationTransactionMode.PerMigration } },
});

class TasksTestConf extends FrameworkConfiguration {
  protected onLoad() {
    return {
      logger: {
        targets: [{ name: 'Empty', type: 'BlackHoleTarget', layout: '{message}' }],
        rules: [{ name: '*', level: 'error', target: 'Empty' }],
      },
      queue: {
        routing: {
          TaskFailed: { connection: 'task-empty-queue' },
          TaskSuccess: { connection: 'task-empty-queue' },
        },
        connections: [
          {
            name: 'task-empty-queue',
            service: 'BlackHoleQueueClient',
            defaultQueueChannel: 'task-jobs',
            defaultTopicChannel: 'task-events',
          },
        ],
      },
      db: { DefaultConnection: 'sqlite', Connections: [sqlite('sqlite'), sqlite('queue')] },
      scheduler: { retention: { enabled: false }, schedules: [] },
      ...overrides,
    };
  }
}

async function boot(extra: Record<string, unknown> = {}): Promise<FakeClock> {
  await DI.dispose();
  overrides = extra;
  const clock = new FakeClock('2026-01-05T10:00:00.000Z');
  DI.register(() => clock).as(Clock);
  DI.register(() => clock.dbSource).as(DbTimeSource);
  DI.register(TasksTestConf).as(Configuration);
  await DI.resolve(Configuration);
  await (await DI.resolve(Orm)).Migrator.ready();
  await DI.resolve(QueueService);
  return clock;
}

const runsOf = (schedule: string) => RunModel.where('Schedule', schedule);

describe('@Task shim over the scheduler', function () {
  this.timeout(30000);

  beforeEach(async () => {
    testTask2Gate.promise = Promise.resolve();
    await boot();
  });

  afterEach(() => sinon.restore());

  it('records each call as a manual scheduler run and keeps the legacy history', async () => {
    const task = new TestTask();
    await task.execute(1);
    await task.execute(1);

    const runs = await runsOf('TestTask');
    expect(runs.map((r) => [r.Trigger, r.Status])).to.deep.eq([
      ['manual', 'succeeded'],
      ['manual', 'succeeded'],
    ]);
    expect(runs[0].TriggeredBy).to.deep.eq({ kind: 'service', id: 'task:TestTask' });
    expect(await __task.all()).to.have.length(1);
    expect(await __task_history.all()).to.have.length(2);
    expect((await __task.where('Name', 'TestTask').first())?.State).to.eq('stopped');
  });

  it('writes no __tasks / __task_history rows with tasks.legacyHistory: false', async () => {
    await boot({ tasks: { legacyHistory: false } });

    expect(await new TestTaskValue().execute()).to.deep.eq({ sent: 3 });

    expect((await runsOf('TestTaskValue')).map((r) => r.Status)).to.deep.eq(['succeeded']);
    expect(await __task.all()).to.have.length(0);
    expect(await __task_history.all()).to.have.length(0);
  });

  it('returns the method value and stores it as the run result', async () => {
    expect(await new TestTaskValue().execute()).to.deep.eq({ sent: 3 });
    const [run] = await runsOf('TestTaskValue');
    expect(run.Result).to.deep.eq({ sent: 3 });
  });

  it('resolves with the error result of a failing method and fails the run', async () => {
    const result = await new TestTask3().execute();

    expect(result).to.deep.equal({ error: true, message: 'task failed' });
    const [row] = await __task_history.all();
    expect(row.Result).to.deep.equal({ error: true, message: 'task failed' });
    const [run] = await runsOf('TestTask3');
    expect(run.Status).to.eq('failed');
    expect(run.Error).to.include({ message: 'task failed' });
  });

  it('records the message of a non-Error throw', async () => {
    expect(await new TestTaskThrowsNull().execute()).to.deep.equal({ error: true, message: 'null' });
    const [row] = await __task_history.all();
    expect(row.Result).to.deep.equal({ error: true, message: 'null' });
  });

  it('emits TaskSuccess and TaskFailed', async () => {
    const success = sinon.spy(TaskSuccess, 'emit');
    const failed = sinon.spy(TaskFailed, 'emit');

    await new TestTask().execute(1);
    await new TestTaskFailing().execute();

    expect(success.calledWithMatch({ TaskName: 'TestTask' })).to.eq(true);
    expect(failed.calledWithMatch({ TaskName: 'TestTaskFailing', Reason: 'boom' })).to.eq(true);
  });

  it("maps taskStacking to the schedule's overlap", async () => {
    const registry = await DI.resolve(ScheduleRegistry);
    expect(registry.get('TestTaskStacking')).to.include({ overlap: 'queue', source: 'decorator' });
    expect(registry.get('TestTask2')).to.include({ overlap: 'skip' });
    expect(registry.get('TestTaskNoOptions').spec).to.include({ kind: 'manual' });
  });

  it('skips a second concurrent call of a non-stacking task', async () => {
    closeTestTask2Gate();
    const task = new TestTask2();
    const first = task.execute(1);
    while ((await runsOf('TestTask2')).length === 0) await new Promise((resolve) => setTimeout(resolve, 5));

    expect(await task.execute(2)).to.eq(undefined);
    const [decl] = getTaskDeclarations('TestTask2');
    expect(await runTask(decl, task, [3], { lock: true, rethrow: true })).to.eq(undefined);

    testTask2Gate.release();
    expect(await first).to.eq(1);
    expect((await runsOf('TestTask2')).map((r) => r.Status)).to.deep.eq(['succeeded']);
    expect(await __task_history.all()).to.have.length(1);
  });

  it('rejects when the run cannot start, instead of reporting a task failure', async () => {
    sinon.stub(await DI.resolve(SchedulerService), 'runInline').rejects(new Error('scheduler tables missing'));
    const failed = sinon.spy(TaskFailed, 'emit');

    await expect(new TestTask().execute(1)).to.be.rejectedWith('scheduler tables missing');
    expect(failed.called).to.eq(false);
  });

  it('returns the value of a method that ran when the run then loses its lease', async () => {
    sinon.stub(LeaseStore.prototype, 'finishRun').resolves(false);

    expect(await new TestTaskValue().execute()).to.deep.eq({ sent: 3 });
  });

  it('reports a failure to finish the run after the method threw as a start failure', async () => {
    sinon.stub(LeaseStore.prototype, 'finishRun').rejects(new Error('db gone'));

    await expect(new TestTaskFailing().execute()).to.be.rejectedWith('db gone');
  });

  it('writes, emits and records nothing after a crash, and rethrows it', async () => {
    const failed = sinon.spy(TaskFailed, 'emit');

    await expect(new TestTaskCrash().execute()).to.be.rejectedWith('process died');

    expect(failed.called).to.eq(false);
    expect(await __task_history.all()).to.have.length(0);
    expect((await runsOf('TestTaskCrash')).map((r) => r.Status)).to.deep.eq(['running']);
  });

  it('runs concurrent calls of a stacking task side by side', async () => {
    closeTestTask2Gate();
    const task = new TestTaskStacking();
    const calls = [task.execute(1), task.execute(2)];
    while ((await runsOf('TestTaskStacking')).length < 2) await new Promise((resolve) => setTimeout(resolve, 5));

    testTask2Gate.release();
    expect(await Promise.all(calls)).to.deep.eq([1, 2]);
  });

  it('runs a config schedule that names the task through the scheduler loop', async () => {
    await boot({ scheduler: { retention: { enabled: false }, schedules: [{ name: 'digest', task: 'TestTaskValue', manual: true }] } });
    const service = await DI.resolve(SchedulerService);
    const scheduler = await DI.resolve(Scheduler, [{ replicaId: 'r1', autoStart: false }]);

    const { runId } = await service.runNow('digest', { triggeredBy: { kind: 'user', id: '1' } });
    await scheduler.tickOnce();
    await scheduler.idle();

    expect(await RunModel.where('Id', runId).first()).to.include({ Status: 'succeeded' });
    const [history] = await __task_history.all();
    expect(history.Result).to.deep.eq({ sent: 3 });
  });

  describe('task declarations', () => {
    it('records a declaration per @Task method', () => {
      const [decl] = getTaskDeclarations('TestTaskNoOptions');

      expect(decl).to.include({
        name: 'TestTaskNoOptions',
        description: 'Task declared without options',
        target: TestTaskNoOptions,
        isStatic: false,
        propertyKey: 'execute',
      });
      expect(decl.options).to.deep.equal(DEFAULT_TASK_OPTIONS);
      expect(decl.method).to.not.equal(Object.getOwnPropertyDescriptor(TestTaskNoOptions.prototype, 'execute')?.value);
      expect(getTaskDeclarations('NoSuchTask')).to.deep.equal([]);
    });

    it('runs without a scheduler run when lock is false', async () => {
      const [decl] = getTaskDeclarations('TestTaskNoOptions');

      await runTask(decl, new TestTaskNoOptions(), [], { lock: false, rethrow: true });

      expect(await __task_history.all()).to.have.length(1);
      expect(await runsOf('TestTaskNoOptions')).to.have.length(0);
    });

    it('writes history and rethrows the error when rethrow is true', async () => {
      const [decl] = getTaskDeclarations('TestTaskFailing');

      await expect(runTask(decl, new TestTaskFailing(), [], { lock: true, rethrow: true })).to.be.rejectedWith('boom');

      const [row] = await __task_history.all();
      expect(row.Result).to.include({ error: true });
    });

    describe('when TaskSuccess cannot be emitted', () => {
      beforeEach(() => sinon.stub(TaskSuccess, 'emit').rejects(new Error('broker down')));

      it('keeps the decorated method resolving with the method value', async () => {
        expect(await new TestTaskValue().execute()).to.deep.equal({ sent: 3 });
        expect(await __task_history.all()).to.have.length(1);
        expect((await runsOf('TestTaskValue')).map((r) => r.Status)).to.deep.eq(['succeeded']);
      });
    });
  });
});
