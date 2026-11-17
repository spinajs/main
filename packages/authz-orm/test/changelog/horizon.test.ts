import * as chai from 'chai';
import 'mocha';
import sinon from 'sinon';

import { AuthzConfigError } from '@spinajs/authz';
import { DI } from '@spinajs/di';
import { Log } from '@spinajs/log-common';
import { MIGRATION_DESCRIPTION_SYMBOL } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';

import { AuthzOrmContributor } from '../../src/contributor.js';
import { AccessResource, AuthzChangeLogHorizon_2026_11_06_00_00_00, CHANGE_LOG_TABLE, DbChangeLog, HORIZON_TABLE, Parent, recordCoverage, restartCoverage } from '../../src/index.js';
import { createChangeLogTables, dropChangeLogTables } from '../support/changelog.js';
import { TestDb } from '../support/db.js';
import type { Dialect } from '../support/db.js';

const expect = chai.expect;

const T1 = new Date('2026-01-01T00:00:00.000Z');
const T2 = new Date('2026-02-01T00:00:00.000Z');
const T3 = new Date('2026-03-01T00:00:00.000Z');

async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected a rejection');
}

describe('changelog horizon', function () {
  this.timeout(60000);
  let db: TestDb;
  let pg = false;

  before(async () => {
    pg = await TestDb.postgresReachable();
    db = await TestDb.open({ postgres: pg });
  });

  after(async () => {
    await db?.close();
  });

  it('the migration is registered on the authz connection', () => {
    expect(DI.getRegisteredTypes('__migrations__')).to.include(AuthzChangeLogHorizon_2026_11_06_00_00_00);
    expect((AuthzChangeLogHorizon_2026_11_06_00_00_00 as unknown as Record<symbol, { Connection: string }>)[MIGRATION_DESCRIPTION_SYMBOL].Connection).to.equal('authz');
  });

  for (const dialect of ['sqlite', 'postgres'] as const satisfies readonly Dialect[]) {
    describe(dialect, () => {
      let driver: OrmDriver;
      const log = new DbChangeLog();

      before(function () {
        if (dialect === 'postgres' && !pg) this.skip();
      });

      beforeEach(async () => {
        driver = db.driver(dialect);
        await createChangeLogTables(db, dialect);
      });

      afterEach(async () => {
        sinon.restore();
        await db.clear();
        await dropChangeLogTables(db, dialect);
      });

      it('the migration creates the horizon and the before column; down drops both', async () => {
        const horizon = await driver.tableInfo(HORIZON_TABLE, driver.Options.Database);
        expect(horizon.map((c) => c.Name).sort()).to.deep.equal(['kind', 'resource_type', 'since']);
        expect(horizon.filter((c) => c.PrimaryKey).map((c) => c.Name).sort()).to.deep.equal(['kind', 'resource_type']);
        const columns = async () => (await driver.tableInfo(CHANGE_LOG_TABLE, driver.Options.Database)).map((c) => c.Name);
        expect(await columns()).to.include('before');
        await new AuthzChangeLogHorizon_2026_11_06_00_00_00().down(driver);
        expect(await columns()).to.not.include('before');
        expect(await driver.tableInfo(HORIZON_TABLE, driver.Options.Database)).to.equal(null);
      });

      it('coveredSince is the first boot that tracked the kind, and survives a process that tracks nothing', async () => {
        await recordCoverage(['assignment'], [], [], T1);
        await recordCoverage(['assignment'], [], [], T2);
        const fresh = new DbChangeLog(); // tracks nothing, like a CLI process
        expect(await fresh.coveredSince('assignment')).to.deep.equal(T1);
        expect(await fresh.coveredSince('tuple')).to.equal(undefined);
        // A type means nothing to the kinds that are not `column`.
        expect(await fresh.coveredSince('assignment', 'doc')).to.deep.equal(T1);
      });

      it('keeps one column row per type, and an explicit opt-out deletes its row', async () => {
        await recordCoverage([], ['doc', 'folder'], [], T1);
        await recordCoverage([], ['doc'], ['folder'], T2);
        expect(await log.coveredSince('column', 'doc')).to.deep.equal(T1);
        expect(await log.coveredSince('column', 'folder')).to.equal(undefined);
        expect(await log.coveredSince('column')).to.equal(undefined);
        expect(await rejection(recordCoverage(['nope' as never], [], []))).to.be.instanceOf(AuthzConfigError);
        expect(await rejection(recordCoverage([], ['x'.repeat(65)], []))).to.be.instanceOf(AuthzConfigError);
      });

      it('restartCoverage moves the horizon forward, never back; column without a type restarts every type', async () => {
        await recordCoverage(['tuple'], ['doc', 'folder'], [], T2);
        await restartCoverage('tuple', undefined, T1);
        expect(await log.coveredSince('tuple')).to.deep.equal(T2);
        await restartCoverage('tuple', undefined, T3);
        expect(await log.coveredSince('tuple')).to.deep.equal(T3);
        await restartCoverage('column', 'doc', T3);
        expect([await log.coveredSince('column', 'doc'), await log.coveredSince('column', 'folder')]).to.deep.equal([T3, T2]);
        const t4 = new Date('2026-04-01T00:00:00.000Z');
        await restartCoverage('column', undefined, t4);
        expect([await log.coveredSince('column', 'doc'), await log.coveredSince('column', 'folder')]).to.deep.equal([t4, t4]);
      });

      it('lost() outside a transaction restarts coverage at once and never rejects', async () => {
        await recordCoverage(['policy'], [], [], T1);
        const before = Date.now();
        await log.lost('policy', undefined, 'test');
        expect((await log.coveredSince('policy'))!.getTime()).to.be.within(before, Date.now());
        const error = sinon.stub(DI.resolve<Log>(Log, ['authz-orm']), 'error');
        await db.raw(`DROP TABLE "${HORIZON_TABLE}"`, [], dialect);
        await log.lost('policy', undefined, 'test');
        expect(error.callCount).to.equal(1);
      });

      it('the domain boot records the column coverage of each @AccessResource type, and drops an opted-out one', async () => {
        await db.define({ name: 'HDoc', columns: { folder_id: 'TEXT' }, decorate: (c, p) => { AccessResource('hdoc')(c); Parent('folder')(p, 'folder_id'); } }, dialect);
        await db.define({ name: 'HQuiet', columns: { folder_id: 'TEXT' }, decorate: (c, p) => { AccessResource('hquiet', { changelog: false })(c); Parent('folder')(p, 'folder_id'); } }, dialect);
        await recordCoverage([], ['hquiet'], [], T1);
        const before = Date.now();
        await new AuthzOrmContributor().contribute('root');
        expect((await log.coveredSince('column', 'hdoc'))!.getTime()).to.be.within(before, Date.now());
        expect(await log.coveredSince('column', 'hquiet')).to.equal(undefined);
      });

      it('a boot that finds no horizon table warns once and does not fail', async () => {
        await db.raw(`DROP TABLE "${HORIZON_TABLE}"`, [], dialect);
        const warn = sinon.stub(DI.resolve<Log>(Log, ['authz-orm']), 'warn');
        const fresh = new DbChangeLog();
        fresh.track('assignment');
        await fresh.recordBootCoverage();
        await fresh.recordBootCoverage();
        expect(warn.getCalls().filter((c) => String(c.args[1]).includes('authz_change_log_horizon')).length).to.equal(1);
        await createChangeLogTables(db, dialect);
        expect(await fresh.coveredSince('assignment')).to.equal(undefined);
      });
    });
  }
});
