import { expect } from 'chai';
import { DI } from '@spinajs/di';
import {
  appendJournalRow,
  FakeClock,
  LatestProgress,
  RunEvent,
  RunEventHub,
  RunEventWriter,
  ProgressSeen,
  RunModel,
  RunStepModel,
} from '../src/index.js';
import { bootTestEnv, waitFor } from './support/env.js';
import { getRun, queuedRun } from './support/fixtures.js';

type Progress = Extract<RunEvent, { type: 'progress' }>;
const progressOf = (events: RunEvent[]) => events.filter((e): e is Progress => e.type === 'progress');
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

describe('latest progress after the per-run cap', () => {
  let clock: FakeClock;
  let writer: RunEventWriter;
  let hub: RunEventHub;
  let run: RunModel;

  /** A running run whose journal holds two progress rows (the cap) for step 'process'. */
  async function cappedRun() {
    run = await queuedRun('import', clock.now(), { Status: 'running', StartedAt: clock.now() });
    await writer.write(run, 1, { type: 'status', status: 'running', reason: null });
    await writer.write(run, 1, { type: 'step-start', step: 'load', stepSeq: 1 });
    await writer.write(run, 1, { type: 'step-end', step: 'load', stepSeq: 1, status: 'succeeded', durationMs: 5 });
    await writer.write(run, 1, { type: 'step-start', step: 'process', stepSeq: 2 });
    await writer.write(run, 1, {
      type: 'progress',
      progress: 55,
      step: 'process',
      stepProgress: 10,
      done: 1,
      total: 10,
    });
    await writer.write(run, 1, {
      type: 'progress',
      progress: 60,
      step: 'process',
      stepProgress: 20,
      done: 2,
      total: 10,
    });
    // dropped by the cap (runLogLimit 2), but the heartbeat keeps the rows current
    expect(
      await writer.write(run, 1, {
        type: 'progress',
        progress: 90,
        step: 'process',
        stepProgress: 80,
        done: 8,
        total: 10,
      }),
    ).to.eq(null);
    await RunStepModel.create({
      RunId: run.Id,
      Attempt: 1,
      Seq: 1,
      Name: 'load',
      Status: 'succeeded',
      Weight: 1,
      StartedAt: clock.now(),
      Progress: 100,
    });
    await RunStepModel.create({
      RunId: run.Id,
      Attempt: 1,
      Seq: 2,
      Name: 'process',
      Status: 'running',
      Weight: 1,
      StartedAt: clock.now(),
      Progress: 80,
      Done: 8,
      Total: 10,
    });
    await RunModel.update({ Progress: 90 }).where('Id', run.Id);
  }

  beforeEach(async () => {
    ({ clock } = await bootTestEnv({ scheduler: { runLogLimit: 2, events: { pollInterval: 1000 } } }));
    writer = DI.resolve(RunEventWriter);
    hub = DI.resolve(RunEventHub);
  });

  it('marks the run once the cap drops a progress row', async () => {
    await cappedRun();
    expect((await getRun(run.Id)).ProgressCapped).to.eq(true);
  });

  it('does not mark the run when the cap drops a log or message row', async () => {
    run = await queuedRun('import', clock.now(), { Status: 'running', StartedAt: clock.now() });
    for (let i = 0; i < 3; i++)
      await writer.write(run, 1, { type: 'message', message: `m${i}`, level: 'info', step: null });
    expect((await getRun(run.Id)).ProgressCapped).to.eq(false);
  });

  it('ends the replay with the latest progress of every step', async () => {
    await cappedRun();
    const got: RunEvent[] = [];
    const off = await hub.subscribe({ runId: run.Id }, (e) => got.push(e));
    off();

    const lastRealSeq = Math.max(...got.filter((e) => !(e.type === 'progress' && e.synthetic)).map((e) => e.seq));
    const synthetic = progressOf(got).filter((e) => e.synthetic);
    expect(synthetic.map((e) => [e.step, e.stepProgress, e.progress, e.done, e.total])).to.deep.eq([
      ['load', 100, 90, undefined, undefined],
      ['process', 80, 90, 8, 10],
    ]);
    expect(synthetic.every((e) => e.seq === lastRealSeq && e.id === 0)).to.eq(true);
    expect(got[got.length - 1]).to.include({ type: 'progress', step: 'process', stepProgress: 80 });
  });

  it('gives a client reconnecting with Last-Event-ID the current percentage', async () => {
    await cappedRun();
    // six journal rows: status, step-start, step-end, step-start and the two stored progress rows
    const lastSeq = 6;
    const got: RunEvent[] = [];
    const off = await hub.subscribe({ runId: run.Id }, (e) => got.push(e), { after: lastSeq });
    off();
    expect(progressOf(got).map((e) => [e.step, e.stepProgress, e.synthetic, e.seq])).to.deep.eq([
      ['load', 100, true, 6],
      ['process', 80, true, 6],
    ]);
  });

  it('keeps a live subscriber on another replica moving and does not repeat unchanged values', async () => {
    await cappedRun();
    const got: RunEvent[] = [];
    const off = await hub.subscribe({ runId: run.Id }, (e) => got.push(e));
    const before = got.length;

    await RunStepModel.update({ Progress: 95, Done: 9 }).where('RunId', run.Id).where('Name', 'process');
    await RunModel.update({ Progress: 97 }).where('Id', run.Id);
    await clock.advance(1000);
    await waitFor(() => got.length === before + 1);
    await clock.advance(1000);
    await settle();
    off();

    expect(got.slice(before)).to.have.length(1);
    expect(got[before]).to.include({
      type: 'progress',
      step: 'process',
      stepProgress: 95,
      progress: 97,
      done: 9,
      synthetic: true,
    });
  });

  it('reports a run progress change that no step row shows on the last step', async () => {
    await cappedRun();
    const got: RunEvent[] = [];
    const off = await hub.subscribe({ runId: run.Id }, (e) => got.push(e));
    const before = got.length;

    await RunModel.update({ Progress: 93 }).where('Id', run.Id);
    await clock.advance(1000);
    await waitFor(() => got.length === before + 1);
    off();
    expect(got[before]).to.include({ type: 'progress', step: 'process', stepProgress: 80, progress: 93 });
  });

  it('does not repeat a value a real progress event already delivered', async () => {
    run = await queuedRun('import', clock.now(), { Status: 'running', StartedAt: clock.now(), ProgressCapped: true });
    await RunModel.update({ Progress: 40 }).where('Id', run.Id);
    await writer.write(run, 1, { type: 'progress', progress: 40, step: null, stepProgress: null });
    const got: RunEvent[] = [];
    const off = await hub.subscribe({ runId: run.Id }, (e) => got.push(e));
    off();
    expect(progressOf(got).map((e) => [e.progress, e.synthetic])).to.deep.eq([[40, undefined]]);
  });

  it('adds the latest progress to a resumed schedule stream at its position', async () => {
    await cappedRun();
    const cursor = (
      await appendJournalRow({
        RunId: 'other',
        Schedule: 'import',
        Seq: 1,
        Attempt: 1,
        Ts: clock.now(),
        Kind: 'status',
        Data: { type: 'status', status: 'queued', reason: null } as never,
      })
    ).Pos;
    const got: RunEvent[] = [];
    const off = await hub.subscribe({ schedule: 'import' }, (e) => got.push(e), { after: cursor });
    off();
    expect(progressOf(got).map((e) => [e.step, e.id, e.seq])).to.deep.eq([
      ['load', cursor, 0],
      ['process', cursor, 0],
    ]);
  });

  it('gives a live-only schedule stream the latest progress on its first poll', async () => {
    await cappedRun();
    const got: RunEvent[] = [];
    const off = await hub.subscribe({ schedule: 'import' }, (e) => got.push(e));
    expect(got).to.have.length(0);
    await clock.advance(1000);
    await waitFor(() => got.length === 2);
    off();
    expect(progressOf(got).every((e) => e.synthetic)).to.eq(true);
  });

  it('skips a step whose row has no values yet', async () => {
    await cappedRun();
    await RunStepModel.create({
      RunId: run.Id,
      Attempt: 1,
      Seq: 3,
      Name: 'save',
      Status: 'running',
      Weight: 1,
      StartedAt: clock.now(),
      Progress: 0,
    });
    const got: RunEvent[] = [];
    const off = await hub.subscribe({ runId: run.Id }, (e) => got.push(e));
    off();
    expect(
      progressOf(got)
        .filter((e) => e.synthetic)
        .map((e) => e.step),
    ).to.deep.eq(['load', 'process']);
  });

  it('leaves runs under the cap alone', async () => {
    await cappedRun();
    await RunModel.update({ ProgressCapped: false }).where('Id', run.Id);
    const got: RunEvent[] = [];
    const off = await hub.subscribe({ runId: run.Id }, (e) => got.push(e));
    off();
    expect(progressOf(got).some((e) => e.synthetic)).to.eq(false);
  });

  it('leaves capped runs that stopped running alone', async () => {
    await cappedRun();
    await RunModel.update({ Status: 'succeeded' }).where('Id', run.Id);
    const got: RunEvent[] = [];
    const off = await hub.subscribe({ runId: run.Id }, (e) => got.push(e));
    off();
    expect(progressOf(got).some((e) => e.synthetic)).to.eq(false);
  });
});

describe('ProgressSeen', () => {
  const progress = (o: Partial<Extract<RunEvent, { type: 'progress' }>>): RunEvent => ({
    id: 0,
    seq: 1,
    runId: 'r',
    schedule: 's',
    attempt: 1,
    ts: '2026-01-05T10:00:00.000Z',
    type: 'progress',
    progress: 10,
    step: 'a',
    stepProgress: 10,
    ...o,
  });

  it('compares a step by its own values and the run by its percentage', () => {
    const seen = new ProgressSeen();
    seen.note(progress({}));
    expect(seen.differs(progress({ progress: 20 }))).to.eq(false);
    expect(seen.runProgressDiffers(progress({ progress: 20 }))).to.eq(true);
    expect(seen.differs(progress({ stepProgress: 11 }))).to.eq(true);
    expect(seen.differs(progress({ attempt: 2 }))).to.eq(true);
  });

  it('reports nothing for a run whose final status was delivered', () => {
    const seen = new ProgressSeen();
    seen.note({ ...progress({}), type: 'status', status: 'succeeded', reason: null });
    expect(seen.differs(progress({ stepProgress: 50 }))).to.eq(false);
    expect(seen.runProgressDiffers(progress({ progress: 50 }))).to.eq(false);
  });
});

describe('latest progress ordering and final status', () => {
  let clock: FakeClock;
  let writer: RunEventWriter;
  let hub: RunEventHub;
  let run: RunModel;

  const step = (seq: number, name: string, progress: number, status: 'running' | 'succeeded' = 'succeeded') =>
    RunStepModel.create({
      RunId: run.Id,
      Attempt: 1,
      Seq: seq,
      Name: name,
      Status: status,
      Weight: 1,
      StartedAt: clock.now(),
      Progress: progress,
    });

  beforeEach(async () => {
    ({ clock } = await bootTestEnv({ scheduler: { runLogLimit: 2, events: { pollInterval: 1000 } } }));
    writer = DI.resolve(RunEventWriter);
    hub = DI.resolve(RunEventHub);
    run = await queuedRun('import', clock.now(), { Status: 'running', StartedAt: clock.now(), ProgressCapped: true });
    await writer.write(run, 1, { type: 'status', status: 'running', reason: null });
  });

  it('orders a repeated step name by its latest row', async () => {
    await step(1, 'fetch', 100);
    await step(2, 'save', 100);
    await step(3, 'fetch', 40, 'running');
    const got: RunEvent[] = [];
    const off = await hub.subscribe({ runId: run.Id }, (e) => got.push(e));
    off();
    expect(progressOf(got).map((e) => [e.step, e.stepProgress])).to.deep.eq([
      ['save', 100],
      ['fetch', 40],
    ]);
  });

  it('never delivers a synthetic event after the final status of its run', async () => {
    await step(1, 'fetch', 40, 'running');
    const got: RunEvent[] = [];
    const off = await hub.subscribe({ runId: run.Id }, (e) => got.push(e));
    expect(got.map((e) => e.type)).to.deep.eq(['status', 'progress']);

    await RunStepModel.update({ Progress: 60 }).where('RunId', run.Id);
    const latest = DI.resolve(LatestProgress);
    const synthesize = latest.synthesize.bind(latest) as LatestProgress['synthesize'];
    // the final status is written and delivered directly while a poll round reads the rows
    latest.synthesize = async (target, seen, cursor) => {
      const events = await synthesize(target, seen, cursor);
      await writer.write(run, 1, { type: 'status', status: 'succeeded', reason: null });
      return events;
    };
    await clock.advance(1000);
    await waitFor(() => got.length === 3);
    await settle();
    off();
    expect(got.map((e) => (e.type === 'status' ? e.status : e.type))).to.deep.eq(['running', 'progress', 'succeeded']);
  });
});
