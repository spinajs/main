import * as chai from 'chai';
import { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { DI } from '@spinajs/di';
import { Orm, QueryContext } from '@spinajs/orm';
import { JobModel } from '@spinajs/queue';
import {
  Clock,
  DbClock,
  FakeClock,
  NonRetryableError,
  resolveSchedulerConfig,
  RunAbortedError,
  SCHEDULER_DEFAULTS,
  ScheduleValidationError,
} from '../src/index.js';
import { bootTestEnv, disposeTestEnv } from './support/env.js';

chai.use(chaiAsPromised);

type RawDriver = { executeOnDb(sql: string, params: unknown[], ctx: QueryContext): Promise<unknown> };
const raw = (name: string) => DI.get(Orm)!.Connections.get(name) as unknown as RawDriver;

describe('scheduler config', () => {
  it('fills defaults and deep-merges nested blocks', () => {
    const cfg = resolveSchedulerConfig({ tick: 500, retention: { runs: '10d' } as never });
    expect(cfg.tick).to.eq(500);
    expect(cfg.leaseTtl).to.eq(60_000);
    expect(cfg.retention.runs).to.eq('10d');
    expect(cfg.retention.logs).to.eq(SCHEDULER_DEFAULTS.retention.logs);
    expect(cfg.events.pollInterval).to.eq(1000);
    expect(resolveSchedulerConfig(undefined)).to.deep.eq(SCHEDULER_DEFAULTS);
  });

  it('error classes carry their data', () => {
    expect(new RunAbortedError('timeout').reason).to.eq('timeout');
    expect(new NonRetryableError('x')).to.be.instanceOf(Error);
    expect(new ScheduleValidationError(['a', 'b']).message)
      .to.contain(' - a')
      .and.contain(' - b');
  });

  it('boots the test environment with a FakeClock and sqlite', async () => {
    const { clock } = await bootTestEnv({ now: '2026-01-05T10:00:00Z' });
    expect(DI.resolve(Clock)).to.eq(clock);
    expect(clock).to.be.instanceOf(FakeClock);
    expect(clock.now()).to.eq(Date.parse('2026-01-05T10:00:00Z'));
  });

  it('gives every boot fresh sqlite databases with the queue tables', async () => {
    await bootTestEnv();
    expect([...DI.get(Orm)!.Connections.keys()]).to.include.members(['sqlite', 'queue']);
    expect(await JobModel.all()).to.deep.eq([]);
    await raw('sqlite').executeOnDb('CREATE TABLE leftover (id INTEGER)', [], QueryContext.Schema);

    await bootTestEnv();
    await expect(raw('sqlite').executeOnDb('SELECT * FROM leftover', [], QueryContext.Select)).to.be.rejected;
  });

  it('resolves DbClock against the FakeClock of the latest boot', async () => {
    await bootTestEnv({ now: '2026-01-05T10:00:00Z' });
    await DI.resolve(DbClock).sync();

    const { clock } = await bootTestEnv({ now: '2026-03-01T08:00:00Z' });
    clock.dbSkewMs = 5000;
    const db = DI.resolve(DbClock);
    expect(await db.sync()).to.eq(Date.parse('2026-03-01T08:00:05Z'));
    await clock.advance(1000);
    expect(db.now()).to.eq(Date.parse('2026-03-01T08:00:06Z'));
  });

  after(() => disposeTestEnv());
});
