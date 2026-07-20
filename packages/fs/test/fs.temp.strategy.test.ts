import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { DateTime } from 'luxon';

import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { InvalidOption } from '@spinajs/exceptions';
import { sleep } from '@spinajs/threading';
import { TestConfiguration } from './common.js';
import { CronTempCleanupStrategy, fs, IFsTempOptions, IStat, MaxAgeTempCleanupStrategy } from '../src/index.js';

const OPTIONS: IFsTempOptions = {
  name: 'fs-temp-stub',
  provider: 'stub-backend',
  maxFileAge: 60,
};

const OLD = DateTime.now().minus({ hours: 1 });
const RECENT = DateTime.now();

/**
 * Minimal fs stub - only members used by MaxAgeTempCleanupStrategy.
 * Pass an Error as stat value to simulate failing stat for that file.
 */
function stubFs(files: Record<string, IStat | Error>) {
  const rm = sinon.stub().resolves();
  const f = {
    Name: 'stub-backend',
    list: sinon.stub().resolves(Object.keys(files)),
    stat: sinon.stub().callsFake((p: string) => {
      const s = files[p];
      if (s instanceof Error) {
        return Promise.reject(s);
      }
      return Promise.resolve(s);
    }),
    rm,
  } as unknown as fs;

  return { fs: f, rm };
}

describe('temp fs cleanup strategy tests', function () {
  this.timeout(15000);

  let strategy: MaxAgeTempCleanupStrategy;

  before(async () => {
    DI.register(TestConfiguration).as(Configuration);
    await DI.resolve(Configuration);

    strategy = await DI.resolve(MaxAgeTempCleanupStrategy);
  });

  afterEach(() => {
    sinon.restore();
  });

  it('should delete file with valid old CreationTime', async () => {
    const { fs, rm } = stubFs({
      'old.txt': { CreationTime: OLD, ModifiedTime: OLD },
    });

    await strategy.cleanup(fs, OPTIONS);

    expect(rm.calledOnceWith('old.txt')).to.be.true;
  });

  it('should keep file younger than maxFileAge', async () => {
    const { fs, rm } = stubFs({
      'fresh.txt': { CreationTime: RECENT, ModifiedTime: RECENT },
    });

    await strategy.cleanup(fs, OPTIONS);

    expect(rm.called).to.be.false;
  });

  it('should fall back to ModifiedTime when CreationTime is epoch ( s3 )', async () => {
    // fs-s3 fills missing times with DateTime.min() / epoch values
    const { fs, rm } = stubFs({
      's3.txt': { CreationTime: DateTime.fromMillis(0), ModifiedTime: OLD },
    });

    await strategy.cleanup(fs, OPTIONS);

    expect(rm.calledOnceWith('s3.txt')).to.be.true;
  });

  it('should fall back to ModifiedTime when CreationTime is undefined ( ftp )', async () => {
    const { fs, rm } = stubFs({
      'ftp.txt': { CreationTime: undefined, ModifiedTime: OLD },
    });

    await strategy.cleanup(fs, OPTIONS);

    expect(rm.calledOnceWith('ftp.txt')).to.be.true;
  });

  it('should keep file with recent ModifiedTime and invalid CreationTime', async () => {
    const { fs, rm } = stubFs({
      'recent.txt': { CreationTime: DateTime.fromMillis(0), ModifiedTime: RECENT },
    });

    await strategy.cleanup(fs, OPTIONS);

    expect(rm.called).to.be.false;
  });

  it('should skip file with no usable timestamp', async () => {
    const { fs, rm } = stubFs({
      'no-dates.txt': { CreationTime: undefined, ModifiedTime: undefined },
    });

    await strategy.cleanup(fs, OPTIONS);

    expect(rm.called).to.be.false;
  });

  it('should continue sweep when stat fails for one file', async () => {
    const { fs, rm } = stubFs({
      'broken.txt': new Error('stat failed'),
      'old.txt': { CreationTime: OLD, ModifiedTime: OLD },
    });

    await strategy.cleanup(fs, OPTIONS);

    expect(rm.calledOnceWith('old.txt')).to.be.true;
  });

  it('should use default maxFileAge ( 1 hour ) when not configured', async () => {
    const { fs, rm } = stubFs({
      'day-old.txt': { CreationTime: DateTime.now().minus({ days: 1 }) },
      'minutes-old.txt': { CreationTime: DateTime.now().minus({ minutes: 5 }) },
    });

    await strategy.cleanup(fs, { name: 'fs-temp-stub', provider: 'stub-backend' });

    expect(rm.calledOnceWith('day-old.txt')).to.be.true;
  });

  it('should run interval scheduling by default and stop cancels future ticks', async () => {
    const { fs } = stubFs({});
    const s = await DI.resolve(MaxAgeTempCleanupStrategy);

    try {
      s.start(fs, { ...OPTIONS, cleanupInterval: 50 });
      await sleep(300);

      const list = fs.list as sinon.SinonStub;
      expect(list.callCount).to.be.greaterThan(0);

      s.stop();
      const countAfterStop = list.callCount;
      await sleep(300);

      expect(list.callCount).to.eq(countAfterStop);
    } finally {
      s.stop();
    }
  });
});

describe('temp fs cron cleanup strategy tests', function () {
  this.timeout(15000);

  before(async () => {
    DI.register(TestConfiguration).as(Configuration);
    await DI.resolve(Configuration);
  });

  afterEach(() => {
    sinon.restore();
  });

  it('should run cleanup sweep on cron schedule', async () => {
    const { fs, rm } = stubFs({
      'old.txt': { CreationTime: OLD, ModifiedTime: OLD },
    });
    const s = await DI.resolve(CronTempCleanupStrategy);

    try {
      // 6-field expression - every second, keeps test fast
      s.start(fs, { ...OPTIONS, cleanupCronExpression: '* * * * * *' });
      await sleep(2500);

      expect(rm.called).to.be.true;
      expect(rm.calledWith('old.txt')).to.be.true;
    } finally {
      s.stop();
    }
  });

  it('should stop cron job and cancel future ticks', async () => {
    const { fs } = stubFs({});
    const s = await DI.resolve(CronTempCleanupStrategy);

    try {
      s.start(fs, { ...OPTIONS, cleanupCronExpression: '* * * * * *' });
      await sleep(1500);

      const list = fs.list as sinon.SinonStub;
      expect(list.callCount).to.be.greaterThan(0);

      s.stop();
      const countAfterStop = list.callCount;
      await sleep(1500);

      expect(list.callCount).to.eq(countAfterStop);
    } finally {
      s.stop();
    }
  });

  it('should throw InvalidOption when cron expression is not set', async () => {
    const { fs } = stubFs({});
    const s = await DI.resolve(CronTempCleanupStrategy);

    expect(() => s.start(fs, OPTIONS)).to.throw(InvalidOption);
  });

  it('should throw InvalidOption on malformed cron expression', async () => {
    const { fs } = stubFs({});
    const s = await DI.resolve(CronTempCleanupStrategy);

    try {
      expect(() => s.start(fs, { ...OPTIONS, cleanupCronExpression: 'not a cron' })).to.throw(InvalidOption);
    } finally {
      s.stop();
    }
  });
});
