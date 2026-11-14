import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { Clock, DbTimeSource } from '@spinajs/durable';
import { FakeClock } from '@spinajs/durable/testing';
import { MigrationTransactionMode, Orm } from '@spinajs/orm';
import '@spinajs/orm-sqlite';
import '@spinajs/log';
// Registers JobModel and the queue_jobs migrations on the `queue` connection.
import '@spinajs/queue';
import '../../src/index.js';

export interface TestEnvOptions {
  now?: string;
  workflow?: Record<string, unknown>;
  /** Top-level config keys applied last, e.g. a whole `db` for the real-database tests. */
  extra?: Record<string, unknown>;
  /** Runs before anything resolves. DI keeps registrations across boots, so register only switchable test doubles. */
  register?: () => void;
}

let current: TestEnvOptions = {};

export const sqlite = (name: string) => ({
  Driver: 'orm-driver-sqlite',
  Filename: ':memory:',
  Name: name,
  Migration: { OnStartup: true, Table: 'orm_migrations', Transaction: { Mode: MigrationTransactionMode.PerMigration } },
});

class WorkflowTestConf extends FrameworkConfiguration {
  protected onLoad() {
    return {
      logger: {
        targets: [{ name: 'Empty', type: 'BlackHoleTarget', layout: '{message}' }],
        rules: [{ name: '*', level: 'error', target: 'Empty' }],
      },
      system: { dirs: { workflows: [] } },
      db: { DefaultConnection: 'sqlite', Connections: [sqlite('sqlite'), sqlite('queue')], Aliases: { workflow: 'sqlite' } },
      workflow: {
        enabled: false,
        tick: 1000,
        concurrency: 10,
        leaseTtl: 60_000,
        shutdownGrace: 2000,
        retry: { attempts: 3, backoff: 'fixed', delay: '10s' },
        ...current.workflow,
      },
      ...current.extra,
    };
  }
}

export async function disposeTestEnv(): Promise<void> {
  await DI.dispose();
}

export async function bootTestEnv(options: TestEnvOptions = {}): Promise<{ clock: FakeClock }> {
  await disposeTestEnv();
  current = options;
  const clock = new FakeClock(options.now ?? '2026-11-10T10:00:00.000Z');
  DI.register(() => clock).as(Clock);
  DI.register(() => clock.dbSource).as(DbTimeSource);
  options.register?.();
  DI.register(WorkflowTestConf).as(Configuration);
  await DI.resolve(Configuration);
  await (await DI.resolve(Orm)).Migrator.ready();
  return { clock };
}

/** Database work behind fake timers completes on real I/O, so tests poll for the outcome. */
export async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`waitFor: condition not met within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
