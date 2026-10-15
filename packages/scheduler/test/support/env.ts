import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { MigrationTransactionMode, Orm } from '@spinajs/orm';
import '@spinajs/orm-sqlite';
import '@spinajs/log';
// Registers JobModel and the queue_jobs migrations on the `queue` connection.
import '@spinajs/queue';
import { Clock, DbTimeSource, FakeClock } from '../../src/index.js';

export interface TestEnvOptions {
  now?: string;
  scheduler?: Record<string, unknown>;
  extra?: Record<string, unknown>;
}

let current: TestEnvOptions = {};

const sqlite = (name: string) => ({
  Driver: 'orm-driver-sqlite',
  Filename: ':memory:',
  Name: name,
  Migration: { OnStartup: true, Table: 'orm_migrations', Transaction: { Mode: MigrationTransactionMode.PerMigration } },
});

class SchedulerTestConf extends FrameworkConfiguration {
  protected onLoad() {
    return {
      logger: {
        targets: [{ name: 'Empty', type: 'BlackHoleTarget', layout: '{message}' }],
        rules: [{ name: '*', level: 'error', target: 'Empty' }],
      },
      // `queue` exists because importing @spinajs/queue registers JobModel on that connection.
      // The queue itself is the shipped default (black-hole); config arrays concatenate, so it is not repeated here.
      db: { DefaultConnection: 'sqlite', Connections: [sqlite('sqlite'), sqlite('queue')] },
      scheduler: {
        tick: 1000,
        leaseTtl: 60_000,
        shutdownGrace: 2000,
        progressFlush: 1000,
        schedules: [],
        retention: { enabled: false },
        ...current.scheduler,
      },
      ...current.extra,
    };
  }
}

/** Disposes everything the previous boot resolved: scheduler loops, timers, DB connections. */
export async function disposeTestEnv(): Promise<void> {
  await DI.dispose();
}

export async function bootTestEnv(options: TestEnvOptions = {}): Promise<{ clock: FakeClock }> {
  await disposeTestEnv();
  current = options;
  DI.setESMModuleSupport();
  const clock = new FakeClock(options.now ?? '2026-01-05T10:00:00.000Z');
  DI.register(() => clock).as(Clock);
  DI.register(() => clock.dbSource).as(DbTimeSource);
  DI.register(SchedulerTestConf).as(Configuration);
  await DI.resolve(Configuration);
  await DI.resolve(Orm);
  return { clock };
}

/** DB work behind fake timers completes on real I/O, so tests poll for the outcome. */
export async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`waitFor: condition not met within ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
