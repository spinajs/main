import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import '@spinajs/log';
import { MigrationTransactionMode, Orm } from '@spinajs/orm';
import '@spinajs/orm-sqlite';
import { Clock, DbTimeSource, FakeClock } from '@spinajs/scheduler';

export const T0 = '2026-11-16T10:00:30.000Z';

export interface SweepEnvOptions {
  idempotency?: Record<string, unknown>;
  schedules?: Record<string, unknown>[];
}

let current: SweepEnvOptions = {};

const sqlite = (name: string) => ({
  Driver: 'orm-driver-sqlite',
  Filename: ':memory:',
  Name: name,
  Migration: { OnStartup: true, Table: 'orm_migrations', Transaction: { Mode: MigrationTransactionMode.PerMigration } },
});

// A FrameworkConfiguration also loads the config the installed packages ship, which the scheduler and the queue need;
// createTestApp({ config }) reads no config files.
class SweepTestConfiguration extends FrameworkConfiguration {
  protected onLoad() {
    return {
      logger: {
        targets: [{ name: 'Empty', type: 'BlackHoleTarget', layout: '{message}' }],
        rules: [{ name: '*', level: 'error', target: 'Empty' }],
      },
      // `queue`: @spinajs/scheduler loads @spinajs/queue, which registers JobModel on that connection
      db: { DefaultConnection: 'sqlite', Connections: [sqlite('sqlite'), sqlite('queue')], Aliases: { idempotency: 'default' } },
      scheduler: { tick: 1000, leaseTtl: 60_000, shutdownGrace: 2000, progressFlush: 1000, schedules: current.schedules ?? [], retention: { enabled: false } },
      idempotency: { store: 'MemoryIdempotencyStore', sweepBatch: 2, ...current.idempotency },
    };
  }
}

export async function disposeSweepEnv(): Promise<void> {
  await DI.dispose();
}

export async function bootSweepEnv(options: SweepEnvOptions = {}): Promise<FakeClock> {
  await disposeSweepEnv();
  current = options;
  DI.setESMModuleSupport();
  const clock = new FakeClock(T0);
  DI.register(() => clock).as(Clock);
  DI.register(() => clock.dbSource).as(DbTimeSource);
  DI.register(SweepTestConfiguration).as(Configuration);
  await DI.resolve(Configuration);
  await (await DI.resolve(Orm)).Migrator.ready();
  return clock;
}
