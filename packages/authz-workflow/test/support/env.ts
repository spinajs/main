import { Bootstrapper, DI } from '@spinajs/di';
import { Clock, DbTimeSource } from '@spinajs/durable';
import { FakeClock } from '@spinajs/durable/testing';
import { MigrationTransactionMode, Orm } from '@spinajs/orm';
import { testHost, type StaticModel } from '@spinajs/authz-testing';
import '@spinajs/orm-sqlite';
import '@spinajs/log';
import '@spinajs/queue';
import '@spinajs/workflow';
import '../../src/index.js';

export const T0 = Date.parse('2026-11-16T10:00:00.000Z');

const sqlite = (name: string) => ({ Driver: 'orm-driver-sqlite', Filename: ':memory:', Name: name, Migration: { OnStartup: true, Table: 'orm_migrations', Transaction: { Mode: MigrationTransactionMode.PerMigration } } });

/** The workflow engine on sqlite with the authz test host as the root domain, deciding by `model`. */
export async function bootAuthzWorkflow(model: StaticModel): Promise<FakeClock> {
  for (const b of await DI.resolve<Bootstrapper>(Array.ofType(Bootstrapper))) await b.bootstrap();
  const cfg = await testHost.installHost();
  cfg.set(['logger'], { targets: [{ name: 'Empty', type: 'BlackHoleTarget', layout: '{message}' }], rules: [{ name: '*', level: 'error', target: 'Empty' }] });
  cfg.set(['db'], { DefaultConnection: 'sqlite', Connections: [sqlite('sqlite'), sqlite('queue')], Aliases: { workflow: 'sqlite' } });
  cfg.set(['system', 'dirs', 'workflows'], []);
  cfg.set(['workflow'], { enabled: false, tick: 1000, concurrency: 1, leaseTtl: 60_000, shutdownGrace: 100, retry: { attempts: 1 } });
  cfg.set(['authz', 'permissions', 'orders:approve'], { description: 'Approve an order' });
  cfg.set(['authz', 'workflow'], { domain: 'root', stampedPrincipalWarning: false });
  const clock = new FakeClock(T0);
  DI.register(() => clock).as(Clock);
  DI.register(() => clock.dbSource).as(DbTimeSource);
  testHost.activate(DI.RootContainer, 'root', model);
  await (await DI.resolve(Orm)).Migrator.ready();
  return clock;
}

export async function disposeAuthzWorkflow(): Promise<void> {
  await DI.get(Orm)?.dispose();
  DI.uncache(Orm);
  await testHost.uninstallHost();
}
