/* eslint-disable @typescript-eslint/no-explicit-any */
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import { QueryContext, RawQuery } from '@spinajs/orm';
import { DateTime } from 'luxon';

import './migrations/PgTypesMigration_2026_10_15_00_02_00.js';
import { IPgSuite, onDatabase, openSuite, PG, reachable, useProcessTimeZone } from './harness.js';
import { PgEvent } from './models/types.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('postgres integration - time (process zone Europe/Warsaw)', function () {
  let suite: IPgSuite;
  let restoreZone: () => void = () => undefined;

  const dbNow = async () => DateTime.fromJSDate((await suite.raw<{ now: Date }[]>('SELECT now() AS now'))[0].now);

  before(async function () {
    restoreZone = useProcessTimeZone('Europe/Warsaw');
    suite = await openSuite(this, { name: 'time' });
  });

  beforeEach(async () => {
    await suite.reset('pg_event', 'pg_lease');
  });

  after(async () => {
    await suite?.close();
    restoreZone();
  });

  it('reads the database clock close to the process clock', async () => {
    expect(Math.abs((await dbNow()).toMillis() - Date.now())).to.be.lessThan(5000);
  });

  it('keeps now() fixed for a transaction while clock_timestamp() moves', async () => {
    await suite.driver.transaction(async () => {
      const [a] = await suite.raw<{ t: Date }[]>('SELECT now() AS t');
      await sleep(50);
      const [b] = await suite.raw<{ t: Date; c: Date }[]>('SELECT now() AS t, clock_timestamp() AS c');

      expect(b.t.getTime()).to.equal(a.t.getTime());
      expect(b.c.getTime()).to.be.greaterThan(a.t.getTime());
    });
  });

  it('round-trips a DateTime to the same instant', async () => {
    const at = DateTime.fromISO('2026-07-01T10:00:00.123Z');
    await new PgEvent({ Name: 'x', At: at }).insert();

    expect((await PgEvent.get(1)).At.toMillis()).to.equal(at.toMillis());
  });

  it('compares an app-written DateTime correctly with now()', async () => {
    await new PgEvent({ Name: 'past', At: DateTime.now().minus({ minutes: 30 }) }).insert();
    await new PgEvent({ Name: 'future', At: DateTime.now().plus({ minutes: 30 }) }).insert();

    expect((await PgEvent.where(RawQuery.create('"At" < now()'))).map((e) => e.Name)).to.deep.equal(['past']);
  });

  it('keeps a lease bound from a db_now read consistent with now()', async () => {
    const now = await dbNow();
    await suite.raw('INSERT INTO "pg_lease" ("Name") VALUES (?)', ['job']);
    await suite.driver.update().in('pg_lease').update({ Owner: 'a', LeaseUntil: now.minus({ seconds: 60 }) }).where('Name', 'job');

    const [row] = await suite.raw<{ expired: boolean }[]>('SELECT ("LeaseUntil" < now()) AS expired FROM "pg_lease" WHERE "Name" = ?', ['job']);
    expect(row.expired).to.equal(true);
  });

  it('addresses a row by equality on a timestamp it read back', async () => {
    await new PgEvent({ Name: 'x' }).insert();
    await suite.driver.executeOnDb('UPDATE "pg_event" SET "At" = clock_timestamp() WHERE "Id" = ?', [1], QueryContext.Update);
    const row = await PgEvent.get(1);

    const result = (await PgEvent.update({ Name: 'hit' }).where('Id', 1).where('At', row.At)) as unknown as { RowsAffected: number };
    expect(result.RowsAffected).to.equal(1);
  });

  it('hydrates DEFAULT CURRENT_TIMESTAMP as the insert instant', async () => {
    await new PgEvent({ Name: 'x' }).insert();

    expect(Math.abs((await PgEvent.get(1)).CreatedAt.toMillis() - Date.now())).to.be.lessThan(5000);
  });

  it('keeps the calendar day of a DATE column', async () => {
    await new PgEvent({ Name: 'x', Day: DateTime.fromISO('2026-10-15') }).insert();

    expect((await PgEvent.get(1)).Day.toISODate()).to.equal('2026-10-15');
  });

  it('stores a DateTime column as timestamptz with millisecond precision', async () => {
    const [column] = await suite.raw<{ udt_name: string; datetime_precision: number }[]>(
      `SELECT udt_name, datetime_precision FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'pg_event' AND column_name = 'At'`,
    );

    expect(column).to.deep.equal({ udt_name: 'timestamptz', datetime_precision: 3 });
  });

  it('runs every pooled session in UTC', async () => {
    const [row] = await suite.raw<{ TimeZone: string }[]>('SHOW TIME ZONE');

    expect(row.TimeZone).to.equal('UTC');
  });

  it('reads and writes the same instant whatever the session time zone', async () => {
    const at = DateTime.fromISO('2026-07-01T12:00:00.123+02:00');

    await suite.driver.transaction(async () => {
      await suite.driver.executeOnDb(`SET LOCAL TIME ZONE 'America/New_York'`, [], QueryContext.Schema);
      await new PgEvent({ Name: 'ny', At: at }).insert();
      const row = await PgEvent.where('Name', 'ny').first();

      expect(row!.At.toMillis()).to.equal(at.toMillis());
      expect(row!.At.zoneName).to.equal('UTC');
    });
  });

  it('reads an instant another client wrote in a non-UTC session, at millisecond precision', async () => {
    // 06:00:00.123456 in New York (EDT) is 10:00:00.123456Z; the column keeps .123
    await suite.external(`INSERT INTO "pg_event" ("Name", "At") VALUES (?, (?::timestamp AT TIME ZONE 'America/New_York'))`, ['ext', '2026-07-01 06:00:00.123456']);

    expect((await PgEvent.where('Name', 'ext').first())!.At.toISO()).to.equal('2026-07-01T10:00:00.123Z');
  });

  it('truncates microseconds of a raw instant to milliseconds', async () => {
    const [row] = await suite.raw<{ t: Date }[]>(`SELECT '2026-07-01 10:00:00.123987+00'::timestamptz AS t`);

    expect(row.t.toISOString()).to.equal('2026-07-01T10:00:00.123Z');
  });

  it('converts a legacy TIMESTAMP column with the documented ALTER', async () => {
    await suite.driver.executeOnDb('CREATE TABLE "pg_legacy_ts" ("Id" int PRIMARY KEY, "At" timestamp(3))', [], QueryContext.Schema);
    // an earlier driver version wrote the wall time of a Europe/Warsaw process
    await suite.driver.executeOnDb(`INSERT INTO "pg_legacy_ts" VALUES (1, '2026-07-01 12:00:00.123')`, [], QueryContext.Insert);
    await suite.driver.executeOnDb(`ALTER TABLE "pg_legacy_ts" ALTER COLUMN "At" TYPE TIMESTAMPTZ(3) USING "At" AT TIME ZONE 'Europe/Warsaw'`, [], QueryContext.Schema);

    const [row] = await suite.raw<{ At: Date }[]>('SELECT "At" FROM "pg_legacy_ts"');
    expect(row.At.toISOString()).to.equal('2026-07-01T10:00:00.123Z');
  });
});

describe('postgres integration - time (database default zone America/New_York)', function () {
  let suite: IPgSuite;
  const database = `"${PG.Database.replace(/"/g, '""')}"`;

  before(async function () {
    // only new sessions see the database default; the driver must still run them in UTC
    if (await reachable()) {
      await onDatabase(`ALTER DATABASE ${database} SET timezone TO 'America/New_York'`);
    }
    suite = await openSuite(this, { name: 'time_ny' });
  });

  after(async () => {
    await suite?.close();
    // always undo: later suites share the database
    if (await reachable()) {
      await onDatabase(`ALTER DATABASE ${database} RESET timezone`);
    }
  });

  it('runs pooled sessions in UTC although the database default is not', async () => {
    const [own] = await suite.raw<{ TimeZone: string }[]>('SHOW TIME ZONE');
    const [external] = await suite.external<{ TimeZone: string }[]>('SHOW TIME ZONE');

    expect(own.TimeZone).to.equal('UTC');
    expect(external.TimeZone).to.equal('America/New_York');
  });

  it('round-trips an instant and compares app-written instants with now()', async () => {
    const at = DateTime.fromISO('2026-07-01T10:00:00.123Z');
    await new PgEvent({ Name: 'fixed', At: at }).insert();
    await new PgEvent({ Name: 'future', At: DateTime.now().plus({ minutes: 30 }) }).insert();

    expect((await PgEvent.where('Name', 'fixed').first())!.At.toMillis()).to.equal(at.toMillis());
    expect((await PgEvent.where(RawQuery.create('"At" < now()'))).map((e) => e.Name)).to.deep.equal(['fixed']);
  });
});
