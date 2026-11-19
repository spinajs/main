import { expect } from 'chai';
import sinon from 'sinon';
import { DI } from '@spinajs/di';
import type { Log } from '@spinajs/log-common';
import {
  defineSchedule,
  FakeClock,
  RunModel,
  Scheduler,
  SchedulerService,
  SchedulerSignals,
  ScheduledTask,
  TriggeredBy,
  undefineSchedule,
} from '../src/index.js';
import { bootTestEnv } from './support/env.js';
import { queuedRun } from './support/fixtures.js';

let cause: string | null = null;
let attempt = 0;
class FlakySensorTask extends ScheduledTask {
  public execute() {
    attempt++;
    // the varying number must not make a repeat look like a new cause
    return cause ? Promise.reject(new Error(`${cause} after ${1000 + attempt} ms`)) : Promise.resolve();
  }
}

/** `@Logger` caches the logger on the class prototype, so this is the logger the scheduler's own instance writes to. */
class ObservedSignals extends SchedulerSignals {
  public get logger(): Log {
    return this.Log;
  }
}

type Level = 'warn' | 'debug' | 'info';
const NAMES = ['sensor', 'sensor-retried', 'sensor-fragile'];
const TIMED_OUT = 'sensor read timed out';
const UNPLUGGED = 'sensor unplugged';
const by: TriggeredBy = { kind: 'user', id: '1' };

describe('a repeated failure warns once per cause', () => {
  let clock: FakeClock;
  let s: Scheduler;
  let lines: Array<[Level, string]>;

  const settle = async () => {
    await s.tickOnce();
    await s.idle();
  };
  const runOnce = async (name: string, extra: Partial<RunModel> = {}) => {
    await queuedRun(name, clock.now(), extra);
    await settle();
  };
  /** A run of `sensor-retried` through all of its attempts. */
  const runRetried = async () => {
    await runOnce('sensor-retried', { MaxAttempts: 3 });
    for (let i = 0; i < 2; i++) {
      clock.set(clock.now() + 2000);
      await settle();
    }
  };
  /** Failure and recovery lines, without the `started` / `ended succeeded` info lines; run ids and durations cut. */
  const reported = () =>
    lines
      .filter(([level, text]) => level !== 'info' || text.startsWith('schedule ') || text.includes(' ended '))
      .filter(([, text]) => !text.includes(' ended succeeded'))
      .map(([level, text]) => [
        level,
        text
          .replace(/^run \S+ of /, '')
          .replace(/ ended (\w+) after \d+ ms/, ' ended $1')
          .replace(/; retrying at .*$/, '; retrying'),
      ]);

  beforeEach(async () => {
    cause = null;
    attempt = 0;
    lines = [];
    defineSchedule(FlakySensorTask, 'sensor', { manual: true });
    defineSchedule(FlakySensorTask, 'sensor-retried', { manual: true, retry: { attempts: 3, delay: '1s' } });
    defineSchedule(FlakySensorTask, 'sensor-fragile', { manual: true, pauseAfterFailures: 2 });
    ({ clock } = await bootTestEnv({ now: '2026-01-05T10:00:00Z' }));
    s = await DI.resolve(Scheduler, [{ replicaId: 'r1', autoStart: false }]);
    const log = DI.resolve(ObservedSignals).logger;
    for (const level of ['warn', 'debug', 'info'] as const) {
      sinon.stub(log, level).callsFake((message: unknown) => void lines.push([level, String(message)]));
    }
  });
  afterEach(() => {
    NAMES.forEach(undefineSchedule);
    sinon.restore();
  });

  it('warns once per cause until the schedule succeeds again, also when causes alternate', async () => {
    for (const c of [TIMED_OUT, TIMED_OUT, UNPLUGGED, TIMED_OUT, UNPLUGGED]) {
      cause = c;
      await runOnce('sensor');
    }
    cause = null;
    await runOnce('sensor');
    cause = TIMED_OUT;
    await runOnce('sensor');

    expect(reported()).to.deep.eq([
      ['warn', 'sensor ended failed: Error: sensor read timed out after 1001 ms'],
      ['debug', 'sensor ended failed: Error: sensor read timed out after 1002 ms'],
      ['warn', 'sensor ended failed: Error: sensor unplugged after 1003 ms'],
      ['debug', 'sensor ended failed: Error: sensor read timed out after 1004 ms'],
      ['debug', 'sensor ended failed: Error: sensor unplugged after 1005 ms'],
      ['info', 'schedule sensor succeeded again after 5 failure(s)'],
      ['warn', 'sensor ended failed: Error: sensor read timed out after 1007 ms'],
    ]);
  });

  it('logs retried attempts at debug and warns once when retried runs keep ending dead', async () => {
    cause = TIMED_OUT;
    await runRetried();
    await runRetried();
    cause = null;
    await runOnce('sensor-retried');

    expect(reported()).to.deep.eq([
      ['debug', 'sensor-retried attempt 1 failed (sensor read timed out after 1001 ms); retrying'],
      ['debug', 'sensor-retried attempt 2 failed (sensor read timed out after 1002 ms); retrying'],
      ['warn', 'sensor-retried ended dead: Error: sensor read timed out after 1003 ms'],
      ['debug', 'sensor-retried attempt 1 failed (sensor read timed out after 1004 ms); retrying'],
      ['debug', 'sensor-retried attempt 2 failed (sensor read timed out after 1005 ms); retrying'],
      ['debug', 'sensor-retried ended dead: Error: sensor read timed out after 1006 ms'],
      ['info', 'schedule sensor-retried succeeded again after 2 failure(s)'],
    ]);
  });

  it('still warns for a shutdown or cancel abort, which neither uses up a cause nor counts as a failure', async () => {
    cause = TIMED_OUT;
    await runOnce('sensor');
    const aborted = await queuedRun('sensor', clock.now(), { Status: 'aborted', Reason: 'shutdown' });
    await DI.resolve(SchedulerSignals).runFinished(aborted, {
      status: 'aborted',
      durationMs: null,
      error: { name: 'AbortError', message: 'shutdown', attempt: 1, occurredAt: new Date(clock.now()).toISOString() },
      countsAsFailure: false,
    });
    await runOnce('sensor');
    cause = null;
    await runOnce('sensor');

    expect(reported()).to.deep.eq([
      ['warn', 'sensor ended failed: Error: sensor read timed out after 1001 ms'],
      ['warn', 'sensor ended aborted: AbortError: shutdown'],
      ['debug', 'sensor ended failed: Error: sensor read timed out after 1002 ms'],
      ['info', 'schedule sensor succeeded again after 2 failure(s)'],
    ]);
  });

  it('warns again for the first failure after a pause by failures', async () => {
    cause = TIMED_OUT;
    await runOnce('sensor-fragile');
    await runOnce('sensor-fragile');
    await (await DI.resolve(SchedulerService)).resume('sensor-fragile', { triggeredBy: by });
    await runOnce('sensor-fragile');
    cause = null;
    await runOnce('sensor-fragile');

    expect(reported().filter(([level]) => level === 'warn')).to.deep.eq([
      ['warn', 'sensor-fragile ended failed: Error: sensor read timed out after 1001 ms'],
      ['warn', 'schedule sensor-fragile paused after 2 consecutive failures'],
      ['warn', 'sensor-fragile ended failed: Error: sensor read timed out after 1003 ms'],
    ]);
    expect(reported().at(-1)).to.deep.eq(['info', 'schedule sensor-fragile succeeded again after 3 failure(s)']);
  });
});
