import { expect } from 'chai';
import { InvalidArgument } from '@spinajs/exceptions';
import { DI } from '@spinajs/di';
import {
  LeaseStore,
  RunAbortedError,
  RunContext,
  RunExecutor,
  RunModel,
  RunStepModel,
  ScheduledTask,
} from '../src/index.js';
import { bootTestEnv } from './support/env.js';
import { getRun, journal, makeDef, queuedRun, seedSchedules } from './support/fixtures.js';

const T = Date.parse('2026-01-05T10:00:00Z');
let seen: unknown;
let badCheckpoint: unknown;
let lostCheckpoint: unknown;

class Logs extends ScheduledTask {
  public async execute(ctx: RunContext) {
    ctx.log.debug('not stored');
    ctx.log.info('outside a step');
    await ctx.step('load', () => ctx.log.warn('inside', { file: 'a.csv' }));
    ctx.log.error('no json', { n: BigInt(1) });
    ctx.result({ imported: 2 });
    return 'ignored because result() was called';
  }
}
class Checkpoints extends ScheduledTask {
  public async execute(ctx: RunContext) {
    seen = ctx.lastCheckpoint;
    await ctx.checkpoint({ cursor: 42 });
    try {
      await ctx.checkpoint({ fn: BigInt(1) });
    } catch (err) {
      badCheckpoint = err;
    }
  }
}
class LosesLease extends ScheduledTask {
  public async execute(ctx: RunContext) {
    await ctx.step('save', async (s) => {
      await RunModel.update({ LeaseOwner: 'r2' }).where('Id', ctx.runId);
      try {
        await ctx.checkpoint({ cursor: 1 });
      } catch (err) {
        lostCheckpoint = err;
      }
      s.message('after the refusal');
      ctx.log.info('after the refusal');
      throw lostCheckpoint;
    });
  }
}

describe('RunContext log, checkpoint, result', () => {
  let leases: LeaseStore;

  async function run(name: string, task: new () => ScheduledTask, extra: Partial<RunModel> = {}) {
    const def = makeDef(name, { manual: true }, task);
    await seedSchedules([def], T);
    const row = await queuedRun(name, T, extra);
    await leases.claimRun(row, T);
    await DI.resolve(RunExecutor, [leases]).start(row, def).done;
    return row;
  }

  beforeEach(async () => {
    seen = undefined;
    badCheckpoint = undefined;
    lostCheckpoint = undefined;
    await bootTestEnv({ now: '2026-01-05T10:00:00Z' });
    leases = DI.resolve(LeaseStore, ['r1']);
  });

  it('journals info and above with the current step, and stores the explicit result', async () => {
    const row = await run('logs', Logs);
    const logs = (await journal(row.Id)).filter((e) => e.type === 'log');
    expect(logs.map((e) => e.type === 'log' && [e.level, e.message, e.step])).to.deep.eq([
      ['info', 'outside a step', null],
      ['warn', 'inside', 'load'],
      ['error', 'no json', null],
    ]);
    expect(logs[1]).to.deep.include({ data: { file: 'a.csv' } });
    expect(logs[2]).to.not.have.property('data');
    expect((await getRun(row.Id)).Result).to.deep.eq({ imported: 2 });
  });

  it('persists checkpoints and exposes the stored one', async () => {
    const row = await run('checkpoints', Checkpoints, { Checkpoint: { cursor: 7 } });
    expect(seen).to.deep.eq({ cursor: 7 });
    expect((await getRun(row.Id)).Checkpoint).to.deep.eq({ cursor: 42 });
    expect(badCheckpoint).to.be.instanceOf(InvalidArgument);
  });

  it('refuses a checkpoint once another replica owns the run', async () => {
    const row = await run('loses-lease', LosesLease, { Checkpoint: { cursor: 0 } });
    expect(lostCheckpoint).to.be.instanceOf(RunAbortedError);
    expect(lostCheckpoint).to.include({ reason: 'lease-lost' });
    const after = await getRun(row.Id);
    expect(after.Checkpoint).to.deep.eq({ cursor: 0 });
    // the refusal aborts the run like a lost heartbeat: nothing is journaled behind the new owner
    expect((await journal(row.Id)).map((e) => (e.type === 'status' ? e.status : e.type))).to.deep.eq([
      'running',
      'step-start',
    ]);
    expect(after).to.include({ Status: 'running', LeaseOwner: 'r2' });
    expect((await RunStepModel.where('RunId', row.Id).first()).Status).to.eq('aborted');
  });
});
