import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { Orm } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';
import { RunModel, ScheduleModel, Scheduler_2026_11_26_00_00_00 } from '../../src/index.js';
import { queuedRun } from '../support/fixtures.js';
import { bootRealDb, REAL_DB_TARGETS } from './real-db.js';

const T = Date.parse('2026-01-05T10:00:00Z');

const driver = (): OrmDriver => {
  const found = DI.get(Orm)?.Connections.get('it');
  if (!found) throw new Error('the it connection is missing');
  return found;
};

const failureOf = (work: Promise<unknown>): Promise<unknown> =>
  work.then(
    () => 'inserted',
    (err: unknown) => err,
  );

const scheduleRow = (tenant: string): Promise<ScheduleModel> =>
  ScheduleModel.create({
    Name: 'close-day',
    Tenant: tenant,
    Definition: {},
    DefinitionHash: 'h',
    NextRunAt: T,
    Paused: false,
    HardPaused: false,
    ConsecutiveFailures: 0,
    Orphaned: false,
    UpdatedAt: T,
  });

for (const target of REAL_DB_TARGETS) {
  (target.enabled ? describe : describe.skip)(`schedule rows per tenant (${target.name})`, function () {
    this.timeout(60_000);

    beforeEach(() => bootRealDb(target));

    it('rebuilds a table of the old shape and keeps its row, BIGINT and boolean columns included', async () => {
      const migration = new Scheduler_2026_11_26_00_00_00();
      await migration.down(driver());
      await driver().insert().into('__scheduler').values({
        Name: 'nightly',
        Definition: '{}',
        DefinitionHash: 'h1',
        NextRunAt: T,
        Paused: true,
        HardPaused: false,
        ConsecutiveFailures: 3,
        LeaseOwner: 'r1',
        LeaseUntil: T + 60_000,
        Orphaned: false,
        UpdatedAt: T,
      });

      await migration.up(driver());
      await migration.up(driver());

      expect(await ScheduleModel.where({ Name: 'nightly', Tenant: '' }).first()).to.include({
        NextRunAt: T,
        Paused: true,
        HardPaused: false,
        ConsecutiveFailures: 3,
        LeaseOwner: 'r1',
        LeaseUntil: T + 60_000,
        Orphaned: false,
      });
    });

    it('keeps one row per name and tenant', async () => {
      await scheduleRow('');
      await scheduleRow('acme');
      expect(await failureOf(scheduleRow('acme'))).to.be.instanceOf(Error);
      expect(await failureOf(scheduleRow(''))).to.be.instanceOf(Error);
      expect(await ScheduleModel.where('Name', 'close-day')).to.have.length(2);
    });

    it('stores the tenant of a run', async () => {
      const acme = await queuedRun('close-day', T, { Tenant: 'acme' });
      expect((await RunModel.where('Id', acme.Id).first()).Tenant).to.eq('acme');
    });

    it('rolls back to the global rows, twice without harm', async () => {
      await scheduleRow('');
      await scheduleRow('acme');
      const migration = new Scheduler_2026_11_26_00_00_00();

      await migration.down(driver());
      await migration.down(driver());

      const rows = await driver().select<Array<Record<string, unknown>>>().from('__scheduler');
      expect(rows.map((r) => r.Name)).to.deep.eq(['close-day']);
      expect((await driver().tableInfo('__scheduler_run')).map((c) => c.Name)).to.not.include('Tenant');
    });
  });
}
