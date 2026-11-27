// A loop process as the docs set it up: it imports @spinajs/tenancy/scheduler and nothing else of the package.
import { randomUUID } from 'node:crypto';
import { DI } from '@spinajs/di';
import { MigrationTransactionMode } from '@spinajs/orm';
import { migrateTestDatabase } from '@spinajs/orm/testing';
import '@spinajs/orm-sqlite';
import { Clock, DbTimeSource, FakeClock, RunModel, ScheduleModel, Scheduler, ScheduledTask, defineSchedule } from '@spinajs/scheduler';
import '@spinajs/tenancy/scheduler';
import { createTestApp } from '@spinajs/testing';

class Ok extends ScheduledTask {
  public execute() {
    return Promise.resolve(null);
  }
}
defineSchedule(Ok, 'ok', { manual: true });

const clock = new FakeClock('2026-01-05T10:00:00Z');
const sqlite = (Name: string) => ({ Driver: 'orm-driver-sqlite', Filename: ':memory:', Name, Migration: { Table: 'orm_migrations', Transaction: { Mode: MigrationTransactionMode.PerMigration } } });
await createTestApp({
  bootstrap: false,
  config: { db: { DefaultConnection: 'sqlite', Connections: [sqlite('sqlite'), sqlite('queue')] }, tenancy: { tenants: [{ id: 'acme' }] } },
  register: (container) => {
    container.register(() => clock).as(Clock);
    container.register(() => clock.dbSource).as(DbTimeSource);
  },
});
await migrateTestDatabase();
const s = await DI.resolve(Scheduler, [{ replicaId: 'r1', autoStart: false }]);
await ScheduleModel.create({ Name: 'ok', Tenant: 'acme', Definition: {}, DefinitionHash: 'h', NextRunAt: null, Paused: false, HardPaused: false, ConsecutiveFailures: 0, Orphaned: false, UpdatedAt: 0 });
await RunModel.create({ Id: randomUUID(), Schedule: 'ok', Tenant: 'acme', Trigger: 'manual', Status: 'queued', Attempt: 1, MaxAttempts: 1, CreatedAt: clock.now(), Progress: 0, CancelRequested: false, Forced: false });
await s.tickOnce();
await s.idle();
const run = await RunModel.where({ Schedule: 'ok', Tenant: 'acme' }).first();
console.log(JSON.stringify({ status: run.Status, error: run.Error?.message ?? null }));
process.exit(0);
