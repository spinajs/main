import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import { DI } from '@spinajs/di';
import {
  ErrorGroupModel,
  ErrorTracker,
  RunFinalizer,
  RunModel,
  SchedulerSignals,
  ScheduleModel,
  StructuredError,
} from '../src/index.js';
import { bootTestEnv } from './support/env.js';

chai.use(chaiAsPromised);
const { expect } = chai;

const T = Date.parse('2026-01-05T10:00:00Z');
const err = (message: string): StructuredError => ({
  name: 'Error',
  message,
  attempt: 1,
  occurredAt: new Date(T).toISOString(),
  stack: `Error: ${message}\n    at Job.execute (/app/lib/Job.js:3:9)`,
});

describe('error tracking', () => {
  let tracker: ErrorTracker;

  beforeEach(async () => {
    await bootTestEnv();
    tracker = DI.resolve(ErrorTracker);
  });
  afterEach(() => sinon.restore());

  it('groups failures that differ only in volatile values', async () => {
    const a = await tracker.record('import', 'r1', err('row 12 failed'), T);
    const b = await tracker.record('import', 'r2', err('row 99 failed'), T + 1000);
    expect(a.fingerprint).to.eq(b.fingerprint);
    const [g] = await ErrorGroupModel.where('Schedule', 'import');
    expect(g).to.include({
      Count: 2,
      FirstSeen: T,
      LastSeen: T + 1000,
      LastRunId: 'r2',
      Status: 'open',
      SampleMessage: 'row 99 failed',
    });
  });

  it('reopens a resolved group and reports the regression; ignored stays ignored', async () => {
    const { fingerprint } = await tracker.record('import', 'r1', err('boom'), T);
    await ErrorGroupModel.update({ Status: 'resolved' }).where('Fingerprint', fingerprint);
    expect((await tracker.record('import', 'r2', err('boom'), T + 1)).regressed).to.eq(true);
    expect((await ErrorGroupModel.where('Fingerprint', fingerprint).first()).Status).to.eq('open');
    await ErrorGroupModel.update({ Status: 'ignored' }).where('Fingerprint', fingerprint);
    expect((await tracker.record('import', 'r3', err('boom'), T + 2)).regressed).to.eq(false);
    expect(await ErrorGroupModel.where('Fingerprint', fingerprint).first()).to.include({ Status: 'ignored', Count: 3 });
  });

  it('counts every concurrent occurrence of a new group in one row', async () => {
    const create = sinon.spy(ErrorGroupModel, 'create');
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((i) => tracker.record('import', `r${i}`, err(`row ${i} failed`), T + i)),
    );
    expect(new Set(results.map((r) => r.fingerprint)).size).to.eq(1);
    const groups = await ErrorGroupModel.where('Schedule', 'import');
    expect(groups).to.have.length(1);
    expect(groups[0].Count).to.eq(5);
    // the insert race on the unique (Schedule, Fingerprint) index was actually taken
    expect(create.callCount).to.be.greaterThan(1);
  });

  it('reports a concurrent regression exactly once', async () => {
    const { fingerprint } = await tracker.record('import', 'r1', err('boom'), T);
    await ErrorGroupModel.update({ Status: 'resolved' }).where('Fingerprint', fingerprint);
    const results = await Promise.all([2, 3, 4, 5].map((i) => tracker.record('import', `r${i}`, err('boom'), T + i)));
    expect(results.filter((r) => r.regressed)).to.have.length(1);
    expect(await ErrorGroupModel.where('Fingerprint', fingerprint).first()).to.include({ Status: 'open', Count: 5 });
  });

  it('rethrows an insert error that is not the unique-index race', async () => {
    sinon.stub(ErrorGroupModel, 'create').rejects(new Error('disk full'));
    await expect(tracker.record('import', 'r1', err('boom'), T)).to.be.rejectedWith('disk full');
  });

  it('caps the sample message and the group name', async () => {
    const long: StructuredError = { ...err('x'.repeat(5000)), name: 'E'.repeat(300) };
    await tracker.record('import', 'r1', long, T);
    const g = await ErrorGroupModel.where('Schedule', 'import').first();
    expect(g.SampleMessage).to.have.length(2000);
    expect(g.Name).to.have.length(128);
  });

  it('is fed by the finalizer, also for retried attempts', async () => {
    await ScheduleModel.create({
      Name: 'import',
      Definition: {},
      DefinitionHash: 'h',
      NextRunAt: null,
      Paused: false,
      HardPaused: false,
      ConsecutiveFailures: 0,
      Orphaned: false,
      UpdatedAt: T,
    });
    const regressed = sinon.spy(SchedulerSignals.prototype, 'errorRegressed');
    const finalizer = DI.resolve(RunFinalizer);
    const run = { Id: 'r1', Schedule: 'import', Attempt: 1, StartedAt: T, Trigger: 'schedule' } as RunModel;
    await finalizer.finalized({
      run,
      status: 'retrying',
      error: err('boom'),
      now: T,
      countsAsFailure: false,
      nextAttemptAt: T + 60_000,
    });
    await finalizer.finalized({ run, status: 'dead', error: err('boom'), now: T + 60_000, countsAsFailure: true });
    expect((await ErrorGroupModel.where('Schedule', 'import').first()).Count).to.eq(2);
    expect(regressed.called).to.eq(false);
  });

  it('does not group a shutdown abort, also not one that will be retried', async () => {
    const finalizer = DI.resolve(RunFinalizer);
    const run = {
      Id: 'r1',
      Schedule: 'import',
      Attempt: 1,
      StartedAt: T,
      Trigger: 'schedule',
      Reason: 'shutdown',
    } as RunModel;
    const aborted = { ...err('Run aborted: shutdown'), name: 'RunAbortedError' };
    await finalizer.finalized({
      run,
      status: 'retrying',
      error: aborted,
      now: T,
      countsAsFailure: false,
      nextAttemptAt: T + 1,
    });
    await finalizer.finalized({ run, status: 'aborted', error: aborted, now: T + 1, countsAsFailure: false });
    expect(await ErrorGroupModel.all()).to.have.length(0);
  });

  it('signals a regression from the finalizer', async () => {
    const { fingerprint } = await tracker.record('import', 'r0', err('boom'), T);
    await ErrorGroupModel.update({ Status: 'resolved' }).where('Fingerprint', fingerprint);
    const regressed = sinon.spy(SchedulerSignals.prototype, 'errorRegressed');
    const run = { Id: 'r1', Schedule: 'import', Attempt: 1, StartedAt: T, Trigger: 'schedule' } as RunModel;
    await DI.resolve(RunFinalizer).finalized({
      run,
      status: 'failed',
      error: err('boom'),
      now: T + 1,
      countsAsFailure: true,
    });
    expect(regressed.calledOnceWith(run, fingerprint)).to.eq(true);
  });

  it('still records the run when error tracking fails', async () => {
    sinon.stub(ErrorTracker.prototype, 'record').rejects(new Error('db down'));
    const finished = sinon.spy(SchedulerSignals.prototype, 'runFinished');
    const run = { Id: 'r1', Schedule: 'import', Attempt: 1, StartedAt: T, Trigger: 'schedule' } as RunModel;
    await DI.resolve(RunFinalizer).finalized({
      run,
      status: 'failed',
      error: err('boom'),
      now: T + 1,
      countsAsFailure: true,
    });
    expect(finished.calledOnce).to.eq(true);
  });
});
