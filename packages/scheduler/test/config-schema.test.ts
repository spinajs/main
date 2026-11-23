import { expect } from 'chai';
import '@spinajs/log';
import { InvalidConfiguration } from '@spinajs/configuration';
import { createTestApp, disposeTestApps } from '@spinajs/testing';
import type { TestApp } from '@spinajs/testing';
import { defineSchedule, parseDuration, ScheduledTask, ScheduleRegistry, undefineSchedule } from '../src/index.js';

const logging = {
  logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'error', target: 'Empty' }] },
};

const SCHEDULE = 'numeric-durations';

class NumericDurations extends ScheduledTask {}

// Every key of the scheduler schema that holds a duration, as a path under `scheduler`.
const KEYS = [
  'emitTimeout',
  'retention.runs',
  'retention.logs',
  'retention.errors',
  'schedules.0.every',
  'schedules.0.jitter',
  'schedules.0.misfireThreshold',
  'schedules.0.timeout',
  'schedules.0.retry.delay',
  'schedules.0.retry.maxDelay',
] as const;

type Key = (typeof KEYS)[number];
type Durations = Record<Key, unknown>;
type Values = Readonly<Record<string, unknown>>;

const each = (value: unknown): Values => Object.fromEntries(KEYS.map((k) => [k, value]));

const schedulerOf = (d: Values) => ({
  emitTimeout: d.emitTimeout,
  retention: { runs: d['retention.runs'], logs: d['retention.logs'], errors: d['retention.errors'] },
  schedules: [
    {
      name: SCHEDULE,
      every: d['schedules.0.every'],
      jitter: d['schedules.0.jitter'],
      misfireThreshold: d['schedules.0.misfireThreshold'],
      timeout: d['schedules.0.timeout'],
      retry: { attempts: 2, delay: d['schedules.0.retry.delay'], maxDelay: d['schedules.0.retry.maxDelay'] },
    },
  ],
});

// createTestApp runs every Bootstrapper, so SchedulerBootstrapper registers the schema as it does in an app. The boot
// timeout is generous because boots take tens of seconds on a loaded machine; it stays below the mocha timeout.
const boot = (d: Values) => createTestApp({ config: { ...logging, scheduler: schedulerOf(d) }, bootTimeout: 150_000 });

const stored = (app: TestApp): Values => Object.fromEntries(KEYS.map((k) => [k, app.config.get<unknown>(`scheduler.${k}`)]));

async function refusal(value: unknown): Promise<InvalidConfiguration> {
  try {
    await boot(each(value));
  } catch (e) {
    if (e instanceof InvalidConfiguration) return e;
    throw e;
  }
  throw new Error(`the configuration loaded with every duration set to ${JSON.stringify(value)}`);
}

describe('scheduler configuration schema: durations', function () {
  this.timeout(180_000);

  before(() => defineSchedule(NumericDurations, SCHEDULE, { manual: true }));
  after(() => undefineSchedule(SCHEDULE));
  afterEach(disposeTestApps);

  it('keeps a duration written as milliseconds a number, and the scheduler reads it', async () => {
    const written: Durations = {
      emitTimeout: 86_400_000,
      'retention.runs': 2_592_000_000,
      'retention.logs': 604_800_000,
      'retention.errors': 7_776_000_000,
      'schedules.0.every': 300_000,
      'schedules.0.jitter': 2_000,
      'schedules.0.misfireThreshold': 10_000,
      'schedules.0.timeout': 60_000,
      'schedules.0.retry.delay': 1_000,
      'schedules.0.retry.maxDelay': 5_000,
    };
    const app = await boot(written);

    expect(stored(app)).to.deep.equal(written);
    expect(parseDuration(app.config.get<number>('scheduler.emitTimeout'))).to.equal(86_400_000);
    expect(parseDuration(app.config.get<number>('scheduler.retention.errors'))).to.equal(7_776_000_000);

    const def = (await app.resolve(ScheduleRegistry)).get(SCHEDULE);
    expect(def.spec).to.deep.include({ kind: 'every', intervalMs: 300_000 });
    expect(def).to.deep.include({ jitterMs: 2_000, misfireThresholdMs: 10_000, timeoutMs: 60_000 });
    expect(def.retry).to.deep.include({ attempts: 2, delayMs: 1_000, maxDelayMs: 5_000 });
  });

  it('keeps a zero a number', async () => {
    expect(stored(await boot(each(0)))).to.deep.equal(each(0));
  });

  it('keeps a duration padded with blanks as written, and the scheduler reads it', async () => {
    const app = await boot(each('  5s  '));

    expect(stored(app)).to.deep.equal(each('  5s  '));
    const def = (await app.resolve(ScheduleRegistry)).get(SCHEDULE);
    expect(def.spec).to.deep.include({ kind: 'every', intervalMs: 5_000 });
    expect(def).to.deep.include({ jitterMs: 5_000, misfireThresholdMs: 5_000, timeoutMs: 5_000 });
  });

  it('keeps a duration with a unit as written', async () => {
    const written: Durations = {
      emitTimeout: ' 36H ',
      'retention.runs': '30d',
      'retention.logs': '0s',
      'retention.errors': '1w',
      'schedules.0.every': '5s',
      'schedules.0.jitter': '1.5s',
      'schedules.0.misfireThreshold': '10S',
      'schedules.0.timeout': '2 h',
      'schedules.0.retry.delay': '500ms',
      'schedules.0.retry.maxDelay': '5Ms',
    };

    expect(stored(await boot(written))).to.deep.equal(written);
  });

  it('reads a string of digits as milliseconds', async () => {
    expect(stored(await boot(each('5000')))).to.deep.equal(each(5000));
  });

  for (const value of [null, true, false, '', ' ', '	', 1.5, -5, 'soon']) {
    it(`refuses ${JSON.stringify(value)} when the configuration loads, naming the key`, async () => {
      const error = await refusal(value);
      const paths = error.violations.map((v) => v.path);

      for (const key of KEYS) {
        expect(paths).to.include(`scheduler.${key}`);
        expect(error.message).to.include(`scheduler.${key} `);
      }
    });
  }
});
