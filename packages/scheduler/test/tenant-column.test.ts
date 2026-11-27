import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { Orm } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';
import { RunModel, ScheduleModel, Scheduler_2026_11_26_00_00_00 } from '../src/index.js';
import { bootTestEnv } from './support/env.js';
import { queuedRun } from './support/fixtures.js';

const T = Date.parse('2026-01-05T10:00:00Z');

const driver = (): OrmDriver => {
  const found = DI.get(Orm)?.Connections.get('default');
  if (!found) throw new Error('the default connection is missing');
  return found;
};

const columnsOf = async (table: string): Promise<string[]> => (await driver().tableInfo(table)).map((c) => c.Name);
const keyOf = async (table: string): Promise<string[]> =>
  (await driver().tableInfo(table)).filter((c) => c.PrimaryKey).map((c) => c.Name);

const scheduleRow = (name: string, tenant?: string): Promise<ScheduleModel> =>
  ScheduleModel.create({
    Name: name,
    ...(tenant === undefined ? {} : { Tenant: tenant }),
    Definition: {},
    DefinitionHash: 'h',
    NextRunAt: T,
    Paused: false,
    HardPaused: false,
    ConsecutiveFailures: 0,
    Orphaned: false,
    UpdatedAt: T,
  });

const failureOf = (work: Promise<unknown>): Promise<unknown> =>
  work.then(
    () => 'inserted',
    (err: unknown) => err,
  );

const oldShapeRow = {
  Name: 'nightly',
  Definition: '{"spec":{"kind":"cron"}}',
  DefinitionHash: 'h1',
  NextRunAt: T,
  LastFiredAt: T - 1000,
  LastStatus: 'succeeded',
  Paused: 1,
  PausedReason: 'manual',
  HardPaused: 0,
  ConsecutiveFailures: 2,
  LastSuccessAt: T - 5000,
  LeaseOwner: 'r1',
  LeaseUntil: T + 60_000,
  Orphaned: 0,
  UpdatedAt: T,
};

/** Rolls back to the shape before the migration and inserts one schedule row there. */
async function oldShapeWithRow(migration: Scheduler_2026_11_26_00_00_00): Promise<void> {
  await migration.down(driver());
  await driver().insert().into('__scheduler').values(oldShapeRow);
}

describe('Scheduler_2026_11_26_00_00_00: one schedule row per tenant', () => {
  beforeEach(() => bootTestEnv());

  it('keys __scheduler by Name and Tenant and gives __scheduler_run a nullable Tenant', async () => {
    expect(await keyOf('__scheduler')).to.have.members(['Name', 'Tenant']);
    expect(await columnsOf('__scheduler_run')).to.include('Tenant');
    const run = await queuedRun('a', T);
    expect((await RunModel.where('Id', run.Id).first()).Tenant).to.eq(null);
  });

  it('keeps one row per name and tenant, the global one under the empty tenant', async () => {
    await scheduleRow('close-day');
    await scheduleRow('close-day', 'acme');
    await scheduleRow('close-day', 'globex');

    expect(await failureOf(scheduleRow('close-day', 'acme'))).to.be.instanceOf(Error);
    expect(await failureOf(scheduleRow('close-day', ''))).to.be.instanceOf(Error);
    expect((await ScheduleModel.where('Name', 'close-day').orderBy('Tenant')).map((r) => r.Tenant)).to.deep.eq([
      '',
      'acme',
      'globex',
    ]);
  });

  it('turns every row of the old shape into the global instance and keeps its columns', async () => {
    const migration = new Scheduler_2026_11_26_00_00_00();
    await migration.down(driver());
    expect(await columnsOf('__scheduler')).to.not.include('Tenant');
    expect(await columnsOf('__scheduler_run')).to.not.include('Tenant');

    await driver().insert().into('__scheduler').values(oldShapeRow);
    await migration.up(driver());

    const row = await ScheduleModel.where({ Name: 'nightly', Tenant: '' }).first();
    expect(row).to.include({
      DefinitionHash: 'h1',
      NextRunAt: T,
      LastFiredAt: T - 1000,
      LastStatus: 'succeeded',
      Paused: true,
      PausedReason: 'manual',
      HardPaused: false,
      ConsecutiveFailures: 2,
      LastSuccessAt: T - 5000,
      LeaseOwner: 'r1',
      LeaseUntil: T + 60_000,
      Orphaned: false,
      UpdatedAt: T,
    });
    expect(row.Definition).to.deep.eq({ spec: { kind: 'cron' } });
    expect(await keyOf('__scheduler')).to.have.members(['Name', 'Tenant']);
  });

  it('keeps the global rows and drops the tenant rows when it is rolled back', async () => {
    await scheduleRow('close-day');
    await scheduleRow('close-day', 'acme');

    await new Scheduler_2026_11_26_00_00_00().down(driver());

    const rows = await driver().select<Array<Record<string, unknown>>>().from('__scheduler');
    expect(rows.map((r) => r.Name)).to.deep.eq(['close-day']);
    expect(await keyOf('__scheduler')).to.deep.eq(['Name']);
  });

  it('changes nothing when it runs a second time in either direction', async () => {
    const migration = new Scheduler_2026_11_26_00_00_00();
    await scheduleRow('close-day', 'acme');
    await migration.up(driver());
    expect((await ScheduleModel.where('Name', 'close-day')).map((r) => r.Tenant)).to.deep.eq(['acme']);

    await migration.down(driver());
    await migration.down(driver());
    expect(await keyOf('__scheduler')).to.deep.eq(['Name']);
    expect(await columnsOf('__scheduler_run')).to.not.include('Tenant');
  });

  it('finishes a rebuild that stopped after the old table was dropped', async () => {
    const migration = new Scheduler_2026_11_26_00_00_00();
    await oldShapeWithRow(migration);
    await migration.up(driver());
    // the state a dying MySQL migration leaves after DROP TABLE __scheduler: the rows wait in the copy
    await driver().index().table('__scheduler').name('__scheduler_due').drop();
    await driver().schema().alterTable('__scheduler', (t) => t.rename('__scheduler_keyed'));

    await migration.up(driver());

    expect(await ScheduleModel.where({ Name: 'nightly', Tenant: '' }).first()).to.include({ ConsecutiveFailures: 2 });
    expect(await driver().schema().tableExists('__scheduler_keyed')).to.eq(false);
  });

  it('starts over from the old table when an interrupted run left a partial copy', async () => {
    const migration = new Scheduler_2026_11_26_00_00_00();
    await oldShapeWithRow(migration);
    await driver()
      .schema()
      .createTable('__scheduler_keyed', (t) => {
        t.string('Name', 128).primaryKey().notNull();
      });

    await migration.up(driver());

    expect(await ScheduleModel.where({ Name: 'nightly', Tenant: '' }).first()).to.include({ LeaseOwner: 'r1' });
    expect(await keyOf('__scheduler')).to.have.members(['Name', 'Tenant']);
  });
});
