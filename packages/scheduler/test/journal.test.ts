import { expect } from 'chai';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { DI } from '@spinajs/di';
import { appendJournalRow, RunEvent, RunEventHub, RunEventWriter, RunLogModel } from '../src/index.js';
import { bootTestEnv, waitFor } from './support/env.js';
import type { FakeClock } from '../src/index.js';

chai.use(chaiAsPromised);

const A = { Id: 'run-a', Schedule: 's' };
const B = { Id: 'run-b', Schedule: 's' };

describe('run event journal', () => {
  let clock: FakeClock;
  let writer: RunEventWriter;
  let hub: RunEventHub;

  /** A write by another replica: in the journal, but never published to this process's hub. */
  const remote = (run: { Id: string; Schedule: string }, seq: number) =>
    appendJournalRow({
      RunId: run.Id,
      Schedule: run.Schedule,
      Seq: seq,
      Attempt: 1,
      Ts: clock.now(),
      Kind: 'status',
      Data: { type: 'status', status: 'running', reason: null },
    });

  beforeEach(async () => {
    ({ clock } = await bootTestEnv({ scheduler: { runLogLimit: 3, events: { pollInterval: 1000 } } }));
    writer = DI.resolve(RunEventWriter);
    hub = DI.resolve(RunEventHub);
  });

  it('assigns per-run seq and global positions', async () => {
    const e1 = await writer.write(A, 1, { type: 'status', status: 'running', reason: null });
    const e2 = await writer.write(A, 1, { type: 'log', level: 'info', message: 'hello', step: null });
    const e3 = await writer.write(B, 1, { type: 'status', status: 'running', reason: null });
    expect([e1!.seq, e2!.seq, e3!.seq]).to.deep.eq([1, 2, 1]);
    expect([e1!.id, e2!.id, e3!.id]).to.deep.eq([1, 2, 3]);
    expect(e1).to.include({ runId: 'run-a', schedule: 's', attempt: 1, ts: '2026-01-05T10:00:00.000Z' });
  });

  it('replays after a cursor, then delivers live events once', async () => {
    await writer.write(A, 1, { type: 'status', status: 'running', reason: null });
    await writer.write(A, 1, { type: 'log', level: 'info', message: 'one', step: null });
    const got: RunEvent[] = [];
    const off = await hub.subscribe({ runId: 'run-a' }, (e) => got.push(e), { after: 1 });
    await writer.write(A, 1, { type: 'log', level: 'info', message: 'two', step: null });
    await clock.advance(1000);
    await waitFor(() => got.length >= 2);
    off();
    expect(got.map((e) => e.seq)).to.deep.eq([2, 3]);
  });

  it('streams all runs of a schedule by position', async () => {
    const got: RunEvent[] = [];
    const off = await hub.subscribe({ schedule: 's' }, (e) => got.push(e));
    await writer.write(A, 1, { type: 'status', status: 'running', reason: null });
    await writer.write(B, 1, { type: 'status', status: 'running', reason: null });
    await waitFor(() => got.length === 2);
    off();
    expect(got.map((e) => e.runId)).to.deep.eq(['run-a', 'run-b']);
    const resumed: RunEvent[] = [];
    const off2 = await hub.subscribe({ schedule: 's' }, (e) => resumed.push(e), { after: got[0].id });
    off2();
    expect(resumed.map((e) => e.runId)).to.deep.eq(['run-b']);
  });

  it('replays a run from its start but starts a schedule stream live when no cursor is given', async () => {
    await writer.write(A, 1, { type: 'status', status: 'running', reason: null });
    const run: RunEvent[] = [];
    const schedule: RunEvent[] = [];
    const offRun = await hub.subscribe({ runId: 'run-a' }, (e) => run.push(e));
    const offSchedule = await hub.subscribe({ schedule: 's' }, (e) => schedule.push(e));
    await writer.write(B, 1, { type: 'status', status: 'running', reason: null });
    await waitFor(() => schedule.length === 1);
    offRun();
    offSchedule();
    expect(run.map((e) => e.seq)).to.deep.eq([1]);
    expect(schedule.map((e) => e.runId)).to.deep.eq(['run-b']);
  });

  it('picks up events written by another replica by polling', async () => {
    const got: RunEvent[] = [];
    const off = await hub.subscribe({ runId: 'run-a' }, (e) => got.push(e));
    await remote(A, 1);
    expect(got).to.have.length(0);
    await clock.advance(1000);
    await waitFor(() => got.length === 1);
    off();
    expect(got.map((e) => e.type)).to.deep.eq(['status']);
  });

  it('never moves a schedule cursor past a position another replica committed first', async () => {
    const got: RunEvent[] = [];
    const off = await hub.subscribe({ schedule: 's' }, (e) => got.push(e));
    // position 1 comes from another replica (no local publish), position 2 is local
    await remote(B, 1);
    await writer.write(A, 1, { type: 'status', status: 'running', reason: null });
    // no clock advance: the local event alone must bring both, in position order
    await waitFor(() => got.length === 2);
    off();
    expect(got.map((e) => [e.id, e.runId])).to.deep.eq([
      [1, 'run-b'],
      [2, 'run-a'],
    ]);
  });

  it('a client resuming a schedule stream on another replica with Last-Event-ID misses nothing', async () => {
    // replica A: this process's writer; replica B: appendJournalRow without a publish
    const firstConnection: RunEvent[] = [];
    const off = await hub.subscribe({ schedule: 's' }, (e) => firstConnection.push(e), { after: 0 });
    await writer.write(A, 1, { type: 'status', status: 'running', reason: null });
    await remote(B, 1);
    await writer.write(A, 1, { type: 'log', level: 'info', message: 'a2', step: null });
    await waitFor(() => firstConnection.length === 3);
    off();
    const lastEventId = firstConnection[firstConnection.length - 1].id;

    await remote(B, 2);
    await writer.write(A, 1, { type: 'log', level: 'info', message: 'a3', step: null });
    await remote(B, 3);

    // The subscription keeps no state besides its cursor, so a new subscription with `after`
    // is exactly what replica B's hub does for a reconnecting client.
    const secondConnection: RunEvent[] = [];
    const off2 = await hub.subscribe({ schedule: 's' }, (e) => secondConnection.push(e), { after: lastEventId });
    off2();

    const all = (await RunLogModel.where('Schedule', 's').orderBy('Pos')).map((r) => r.Pos);
    expect([...firstConnection, ...secondConnection].map((e) => e.id)).to.deep.eq(all);
    expect(all).to.deep.eq([1, 2, 3, 4, 5, 6]);
  });

  it('keeps positions dense after a failed append', async () => {
    await remote(A, 1);
    await expect(remote(A, 1)).to.be.rejected;
    const next = await remote(A, 2);
    expect(next.Pos).to.eq(2);
  });

  it('caps log rows per run but never drops status rows', async () => {
    for (let i = 0; i < 5; i++) await writer.write(A, 1, { type: 'log', level: 'info', message: `l${i}`, step: null });
    expect(await writer.write(A, 1, { type: 'status', status: 'succeeded', reason: null })).to.not.eq(null);
    expect(await RunLogModel.count((b) => b.where('RunId', 'run-a').where('Kind', 'log'))).to.eq(3);
  });

  it('serializes concurrent writes of one run, so a live run stream misses none', async () => {
    const got: RunEvent[] = [];
    const off = await hub.subscribe({ runId: 'run-a' }, (e) => got.push(e));
    const written = await Promise.all(
      [1, 2, 3, 4, 5].map((i) => writer.write(A, 1, { type: 'status', status: 'running', reason: `r${i}` })),
    );
    off();
    expect(written.map((e) => e!.seq)).to.deep.eq([1, 2, 3, 4, 5]);
    expect(got.map((e) => e.seq)).to.deep.eq([1, 2, 3, 4, 5]);
  });

  it('caps message and progress rows per run as well', async () => {
    const dropped: Array<RunEvent | null> = [];
    for (let i = 0; i < 5; i++) {
      dropped.push(await writer.write(A, 1, { type: 'message', message: `m${i}`, level: 'info', step: null }));
      dropped.push(await writer.write(A, 1, { type: 'progress', progress: i * 10, step: null, stepProgress: null }));
    }
    expect(dropped.filter((e) => e === null)).to.have.length(4);
    expect(await RunLogModel.count((b) => b.where('RunId', 'run-a').where('Kind', 'message'))).to.eq(3);
    expect(await RunLogModel.count((b) => b.where('RunId', 'run-a').where('Kind', 'progress'))).to.eq(3);
  });

  it('a failed write does not use up the cap', async () => {
    await remote(A, 1);
    // the writer's cached seq collides three times with rows another replica wrote
    const original = writer['nextSeq'].bind(writer);
    let calls = 0;
    writer['nextSeq'] = async (...args: Parameters<typeof original>) => (++calls <= 3 ? 1 : original(...args));
    await expect(writer.write(A, 1, { type: 'log', level: 'info', message: 'lost', step: null })).to.be.rejected;
    writer['nextSeq'] = original;
    for (let i = 0; i < 3; i++) {
      expect(await writer.write(A, 1, { type: 'log', level: 'info', message: `l${i}`, step: null })).to.not.eq(null);
    }
  });

  it('a run stream never skips a seq another replica wrote between two local events', async () => {
    const got: RunEvent[] = [];
    const off = await hub.subscribe({ runId: 'run-a' }, (e) => got.push(e));
    await writer.write(A, 1, { type: 'status', status: 'running', reason: null });
    await waitFor(() => got.length === 1);
    // the reaper on another replica
    await appendJournalRow({
      RunId: 'run-a',
      Schedule: 's',
      Seq: 2,
      Attempt: 1,
      Ts: clock.now(),
      Kind: 'status',
      Data: { type: 'status', status: 'retrying', reason: 'lease-expired' },
    });
    // the stalled owner writes again: its cached seq collides, it re-reads and publishes seq 3
    await writer.write(A, 1, { type: 'log', level: 'info', message: 'late', step: null });
    await waitFor(() => got.length === 3);
    off();
    expect(got.map((e) => e.seq)).to.deep.eq([1, 2, 3]);
  });

  it('unsubscribing removes the listener and the poll timer', async () => {
    const emitter = hub['emitter'];
    const timers = clock.pendingTimers;
    const offRun = await hub.subscribe({ runId: 'run-a' }, () => undefined);
    const offSchedule = await hub.subscribe({ schedule: 's' }, () => undefined);
    expect(emitter.listenerCount('run:run-a') + emitter.listenerCount('schedule:s')).to.eq(2);
    expect(clock.pendingTimers).to.eq(timers + 2);
    offRun();
    offSchedule();
    expect(emitter.listenerCount('run:run-a') + emitter.listenerCount('schedule:s')).to.eq(0);
    expect(clock.pendingTimers).to.eq(timers);
  });

  it('a failed first replay rejects, delivers nothing and leaves no listener or timer', async () => {
    const timers = clock.pendingTimers;
    const got: RunEvent[] = [];
    hub.fetchAfter = async () => {
      // published while the replay is in flight: must not reach a subscription that fails
      hub.publish({
        type: 'status',
        status: 'running',
        reason: null,
        id: 1,
        seq: 1,
        runId: 'run-a',
        schedule: 's',
        attempt: 1,
        ts: '2026-01-05T10:00:00.000Z',
      });
      throw new Error('db down');
    };
    await expect(hub.subscribe({ runId: 'run-a' }, (e) => got.push(e))).to.be.rejectedWith('db down');
    expect(got).to.have.length(0);
    expect(hub['emitter'].listenerCount('run:run-a')).to.eq(0);
    expect(clock.pendingTimers).to.eq(timers);
  });

  it('drops a run from its cache once a terminal status is written', async () => {
    await writer.write(A, 1, { type: 'log', level: 'info', message: 'x', step: null });
    await writer.write(A, 1, { type: 'status', status: 'retrying', reason: null });
    expect(writer['cache'].has('run-a')).to.eq(true);
    await writer.write(A, 2, { type: 'status', status: 'succeeded', reason: null });
    expect(writer['cache'].has('run-a')).to.eq(false);
    expect((await writer.write(A, 2, { type: 'log', level: 'info', message: 'after', step: null }))!.seq).to.eq(4);
  });

  it('continues the sequence from the database after forget()', async () => {
    await writer.write(A, 1, { type: 'status', status: 'running', reason: null });
    writer.forget('run-a');
    expect((await writer.write(A, 2, { type: 'status', status: 'running', reason: null }))!.seq).to.eq(2);
  });
});
