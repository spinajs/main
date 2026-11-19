import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { InvalidOperation } from '@spinajs/exceptions';
import {
  defineSchedule,
  exitCodeForError,
  FakeClock,
  httpStatusForError,
  RunLogModel,
  RunModel,
  Scheduler,
  SchedulerNotRunning,
  SchedulerService,
  ScheduledTask,
  TriggeredBy,
  undefineSchedule,
} from '../src/index.js';
import { bootTestEnv } from './support/env.js';
import { driveUntil } from './support/fixtures.js';

const by: TriggeredBy = { kind: 'system', id: 'test' };

class WaitNoLoopTask extends ScheduledTask {
  public async execute() {}
}

/** In real time: a refusal settles at once, a wait that nothing ends never does. */
function outcome(work: Promise<unknown>, ms = 1000): Promise<unknown> {
  return Promise.race([
    work.then(
      () => 'returned',
      (err: unknown) => err,
    ),
    new Promise((resolve) => setTimeout(() => resolve('still waiting'), ms)),
  ]);
}

async function expectRefusedWithoutRun(service: SchedulerService): Promise<void> {
  const err = await outcome(service.runNow('once', { wait: true, triggeredBy: by }));
  expect(err).to.be.instanceOf(SchedulerNotRunning);
  expect(err).to.be.instanceOf(InvalidOperation);
  expect((err as Error).message).to.contain('timeoutMs');
  expect(await RunModel.all()).to.have.length(0);
  expect(await RunLogModel.all()).to.have.length(0);
}

describe('SchedulerService.runNow with wait when no loop runs in this process', () => {
  let clock: FakeClock;
  let service: SchedulerService;

  beforeEach(async () => {
    defineSchedule(WaitNoLoopTask, 'once', { manual: true });
    ({ clock } = await bootTestEnv({ now: '2026-01-05T10:00:00Z' }));
    service = await DI.resolve(SchedulerService);
  });
  afterEach(() => undefineSchedule('once'));

  it('refuses at once, before a run is written, while the loop of this process is not started', async () => {
    await DI.resolve(Scheduler, [{ replicaId: 'r1', autoStart: false }]);
    await expectRefusedWithoutRun(service);
  });

  it('refuses in a process that never resolved the scheduler', async () => {
    await expectRefusedWithoutRun(service);
  });

  it('refuses once the loop has stopped', async () => {
    const s = await DI.resolve(Scheduler, [{ replicaId: 'r1', autoStart: false }]);
    s.start();
    await s.stop();
    await expectRefusedWithoutRun(service);
  });

  it('answers as an invalid state: 409 over HTTP, exit code 3 in the CLI', async () => {
    const err = await outcome(service.runNow('once', { wait: true, triggeredBy: by }));
    expect(httpStatusForError(err)).to.eq(409);
    expect(exitCodeForError(err)).to.eq(3);
  });

  it('waits for the end of the run while the loop runs', async () => {
    const s = await DI.resolve(Scheduler, [{ replicaId: 'r1', autoStart: false }]);
    s.start();
    const pending = service.runNow('once', { wait: true, triggeredBy: by });
    await driveUntil(clock, pending);
    expect((await pending).run).to.include({ status: 'succeeded' });
    await s.stop();
  });
});
