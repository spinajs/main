import * as chai from 'chai';
import 'mocha';
import sinon from 'sinon';

import { AuthzConfigError } from '@spinajs/authz';
import { DI } from '@spinajs/di';
import { Log } from '@spinajs/log-common';
import { MIGRATION_DESCRIPTION_SYMBOL, ModelBase } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';

import { AuthzOrmContributor } from '../../src/contributor.js';
import { unregisterResource } from '../../src/registry.js';
import { DateTime } from 'luxon';

import { AccessResource, AuthzChangeLogHorizon_2026_11_06_00_00_00, CHANGE_LOG_TABLE, DbChangeLog, HORIZON_TABLE, HorizonRecord, LOST_TABLE, LostRecord, Owner, Parent, pruneChangeLog, recordCoverage, relationFingerprint, restartCoverage } from '../../src/index.js';
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

  it('the fingerprint of a type changes with its relation columns, not with their order', () => {
    const doc = { table: 'doc', columns: [{ relation: 'parent', column: 'folder_id', type: 'folder' }, { relation: 'owner', column: 'owner_id', type: 'user' }] };
    const note = { table: 'note', columns: [{ relation: 'parent', column: 'doc_id', type: 'doc' }] };
    const base = relationFingerprint([doc, note]);
    expect(base).to.match(/^[0-9a-f]{64}$/);
    expect(relationFingerprint([note, { ...doc, columns: [...doc.columns].reverse() }])).to.equal(base);
    expect(relationFingerprint([{ ...doc, columns: [...doc.columns, { relation: 'editor', column: 'editor_id', typeColumn: 'editor_type' }] }, note])).to.not.equal(base);
    expect(relationFingerprint([{ ...doc, columns: doc.columns.slice(1) }, note])).to.not.equal(base);
    expect(relationFingerprint([doc])).to.not.equal(base);
    expect(relationFingerprint([{ ...doc, columns: [{ ...doc.columns[0], type: 'org' }, doc.columns[1]] }, note])).to.not.equal(base);
    expect(relationFingerprint([{ ...doc, idColumn: 'uuid' }, note])).to.not.equal(base);
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
        expect(horizon.map((c) => c.Name).sort()).to.deep.equal(['fingerprint', 'kind', 'resource_type', 'since']);
        expect(horizon.filter((c) => c.PrimaryKey).map((c) => c.Name).sort()).to.deep.equal(['kind', 'resource_type']);
        expect((await driver.tableInfo(LOST_TABLE, driver.Options.Database)).map((c) => c.Name).sort()).to.deep.equal(['at', 'id', 'kind', 'resource_type']);
        const columns = async () => (await driver.tableInfo(CHANGE_LOG_TABLE, driver.Options.Database)).map((c) => c.Name);
        expect(await columns()).to.include('before');
        await new AuthzChangeLogHorizon_2026_11_06_00_00_00().down(driver);
        expect(await columns()).to.not.include('before');
        expect(await driver.tableInfo(HORIZON_TABLE, driver.Options.Database)).to.equal(null);
        expect(await driver.tableInfo(LOST_TABLE, driver.Options.Database)).to.equal(null);
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

      it('lost() outside a transaction leaves a marker at once: coverage starts at the later of the horizon and the marker', async () => {
        await recordCoverage(['policy'], ['doc', 'folder'], [], T1);
        const before = Date.now();
        await log.lost('policy', undefined, 'test');
        expect((await log.coveredSince('policy'))!.getTime()).to.be.within(before, Date.now());
        await log.lost('column', 'doc', 'test');
        expect(await log.coveredSince('column', 'folder')).to.deep.equal(T1);
        await log.lost('column', undefined, 'test');
        expect((await log.coveredSince('column', 'folder'))!.getTime()).to.be.within(before, Date.now());
        const later = new Date(Date.now() + 60_000);
        await restartCoverage('policy', undefined, later);
        expect(await log.coveredSince('policy')).to.deep.equal(later);
        // A marker without a horizon row claims nothing.
        await log.lost('tuple', undefined, 'test');
        expect(await log.coveredSince('tuple')).to.equal(undefined);
      });

      it('a prune between the two coverage reads cannot hide a marker newer than the old horizon', async () => {
        await recordCoverage(['policy'], [], [], T1);
        await LostRecord.insert({ kind: 'policy', resource_type: '', at: DateTime.fromJSDate(T2) });
        let reads = 0;
        const prune = (): Promise<unknown> => (++reads === 2 ? pruneChangeLog(1, new Date(T3.getTime() + 24 * 60 * 60 * 1000)) : Promise.resolve());
        const delayed = <Q extends PromiseLike<unknown>>(q: Q): Q => {
          const then = q.then.bind(q);
          return Object.assign(q, { then: (ok?: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => prune().then(() => then(ok, ko)) });
        };
        const horizon = HorizonRecord.query.bind(HorizonRecord);
        const markers = LostRecord.query.bind(LostRecord);
        sinon.stub(HorizonRecord, 'query').callsFake(() => delayed(horizon()));
        sinon.stub(LostRecord, 'query').callsFake(() => delayed(markers()));
        expect(await log.coveredSince('policy')).to.deep.equal(T3);
        expect(reads).to.be.at.least(2);
      });

      it('before the migration, lost() warns once, inserts nothing and leaves the write alone', async () => {
        const error = sinon.stub(DI.resolve<Log>(Log, ['authz-orm']), 'error');
        const warn = sinon.stub(DI.resolve<Log>(Log, ['authz-orm']), 'warn');
        await db.raw(`DROP TABLE "${LOST_TABLE}"`, [], dialect);
        const fresh = new DbChangeLog();
        await fresh.lost('policy', undefined, 'test');
        await driver.transaction(async () => {
          await log.append([{ kind: 'policy', op: 'remove', key: 'p' }]);
          await fresh.lost('policy', undefined, 'test');
          await log.append([{ kind: 'policy', op: 'add', key: 'q' }]);
        });
        expect((await log.since(0)).map((c) => c.key)).to.deep.equal(['p', 'q']);
        expect([error.callCount, warn.getCalls().filter((c) => String(c.args[1]).includes(LOST_TABLE)).length]).to.deep.equal([0, 1]);
      });

      it('retention prunes and moves the horizon together, and deletes nothing without the horizon table', async () => {
        const now = new Date('2026-11-06T00:00:00Z');
        const old = new Date('2025-01-02T00:00:00Z');
        await recordCoverage(['tuple'], [], [], new Date('2025-01-01T00:00:00Z'));
        await driver.transaction(() => log.append([{ kind: 'tuple', op: 'add', key: 'old', at: old }, { kind: 'tuple', op: 'add', key: 'new', at: new Date('2026-11-01T00:00:00Z') }]));
        await LostRecord.insert([
          { kind: 'tuple', resource_type: '', at: DateTime.fromJSDate(old) },
          { kind: 'rule', resource_type: '', at: DateTime.fromISO('2026-10-01T00:00:00Z') },
        ]);
        expect(await pruneChangeLog(400, now)).to.equal(1);
        expect((await log.coveredSince('tuple'))!.toISOString()).to.equal('2025-10-02T00:00:00.000Z');
        expect((await LostRecord.all()).map((r) => r.kind)).to.deep.equal(['rule']);
        await driver.transaction(() => log.append([{ kind: 'tuple', op: 'add', key: 'old2', at: old }]));
        await db.raw(`DROP TABLE "${HORIZON_TABLE}"`, [], dialect);
        await rejection(pruneChangeLog(400, now));
        expect((await log.since(0)).map((c) => c.key)).to.deep.equal(['new', 'old2']);
      });

      it('two boots racing past the select leave one row per kind and type', async () => {
        const boot = (at: Date) => recordCoverage(['rule'], [{ type: 'doc', fingerprint: 'a' }], [], at);
        await Promise.all([boot(T1), boot(T2), boot(T3)]);
        const rows = await HorizonRecord.all();
        expect(rows.map((r) => [r.kind, r.resource_type]).sort()).to.deep.equal([
          ['column', 'doc'],
          ['rule', ''],
        ]);
      });

      it('a committed lost write moves coverage to the moment of lost()', async () => {
        await recordCoverage(['policy'], [], [], T1);
        const before = Date.now();
        let inside = 0;
        await driver.transaction(async () => {
          await log.lost('policy', undefined, 'test');
          inside = Date.now();
        });
        expect((await log.coveredSince('policy'))!.getTime()).to.be.within(before, inside);
      });

      it('two parallel lost() calls of one transaction both resolve, leave one marker and the transaction commits', async () => {
        await recordCoverage(['policy'], ['doc'], [], T1);
        await driver.transaction(async () => {
          await log.append([{ kind: 'policy', op: 'remove', key: 'p' }]);
          await Promise.all([log.lost('column', 'doc', 'a'), log.lost('column', 'doc', 'b'), log.lost('policy', undefined, 'c')]);
          await log.append([{ kind: 'policy', op: 'add', key: 'q' }]);
        });
        expect((await log.since(0)).map((c) => c.key)).to.deep.equal(['p', 'q']);
        expect((await LostRecord.all()).map((r) => [r.kind, r.resource_type]).sort()).to.deep.equal([
          ['column', 'doc'],
          ['policy', ''],
        ]);
      });

      it('a marker that a savepoint rolled back is written again by the next lost() of the transaction', async () => {
        await recordCoverage(['policy'], [], [], T1);
        await driver.transaction(async () => {
          await driver.transaction(async () => {
            await log.lost('policy', undefined, 'inner');
            throw new Error('roll back the savepoint');
          }).catch(() => undefined);
          await log.lost('policy', undefined, 'outer');
          await log.lost('policy', undefined, 'again');
        });
        expect(await LostRecord.all()).to.have.length(1);
        expect((await log.coveredSince('policy'))!.getTime()).to.be.greaterThan(T1.getTime());
      });

      it('a marker that cannot be inserted fails the write', async () => {
        await recordCoverage(['policy'], [], [], T1);
        sinon.stub(LostRecord, 'insert').rejects(new Error('lock timeout'));
        const error = await rejection(
          driver.transaction(async () => {
            await log.append([{ kind: 'policy', op: 'remove', key: 'p' }]);
            await log.lost('policy', undefined, 'test');
          }),
        );
        expect(error.message).to.equal('lock timeout');
        expect(await log.since(0)).to.deep.equal([]);
        expect((await rejection(new DbChangeLog().lost('policy', undefined, 'test'))).message).to.equal('lock timeout');
        expect(await log.coveredSince('policy')).to.deep.equal(T1);
      });

      it('lost() in a transaction that rolls back leaves the horizon where it was', async () => {
        await recordCoverage(['policy'], [], [], T1);
        await driver
          .transaction(async () => {
            await log.lost('policy', undefined, 'test');
            throw new Error('roll back');
          })
          .catch(() => undefined);
        expect(await log.coveredSince('policy')).to.deep.equal(T1);
      });

      it('a column row restarts when its relation fingerprint differs, and keeps its since when it is equal', async () => {
        await recordCoverage([], [{ type: 'doc', fingerprint: 'a' }, 'folder'], [], T1);
        await recordCoverage([], [{ type: 'doc', fingerprint: 'a' }], [], T2);
        expect(await log.coveredSince('column', 'doc')).to.deep.equal(T1);
        await recordCoverage([], [{ type: 'doc', fingerprint: 'b' }, { type: 'folder', fingerprint: 'f' }], [], T2);
        expect([await log.coveredSince('column', 'doc'), await log.coveredSince('column', 'folder')]).to.deep.equal([T2, T2]);
        await recordCoverage([], [{ type: 'doc', fingerprint: 'b' }, { type: 'folder', fingerprint: 'f' }], [], T3);
        expect([await log.coveredSince('column', 'doc'), await log.coveredSince('column', 'folder')]).to.deep.equal([T2, T2]);
        // A fingerprint change never moves `since` back.
        await recordCoverage([], [{ type: 'doc', fingerprint: 'c' }], [], T1);
        expect(await log.coveredSince('column', 'doc')).to.deep.equal(T2);
        expect((await HorizonRecord.where('resource_type', 'doc')).map((r) => r.fingerprint)).to.deep.equal(['c']);
      });

      it('two boots with different fingerprints only move coverage forward', async () => {
        await recordCoverage([], [{ type: 'doc', fingerprint: 'x' }], [], T1);
        await Promise.all([recordCoverage([], [{ type: 'doc', fingerprint: 'a' }], [], T2), recordCoverage([], [{ type: 'doc', fingerprint: 'b' }], [], T3)]);
        expect(await log.coveredSince('column', 'doc')).to.deep.equal(T3);
        expect(['a', 'b']).to.include((await HorizonRecord.where('resource_type', 'doc'))[0].fingerprint);
      });

      it('a registered model without a table does not fail the domain boot', async () => {
        class Orphan extends ModelBase<Orphan> {}
        AccessResource('orphan')(Orphan);
        Parent('folder')(Orphan.prototype, 'folder_id');
        sinon.stub(DI.resolve<Log>(Log, ['authz-orm']), 'warn');
        try {
          await new AuthzOrmContributor().contribute('root');
        } finally {
          unregisterResource(Orphan);
        }
      });

      it('the domain boot restarts the coverage of a type that gains a relation column', async () => {
        await db.define({ name: 'FpDoc', columns: { folder_id: 'TEXT' }, decorate: (c, p) => { AccessResource('hfp')(c); Parent('folder')(p, 'folder_id'); } }, dialect);
        const contributor = new AuthzOrmContributor();
        await contributor.contribute('root');
        const first = (await log.coveredSince('column', 'hfp'))!;
        await contributor.contribute('root');
        expect(await log.coveredSince('column', 'hfp')).to.deep.equal(first);
        await db.define({ name: 'FpNote', columns: { owner_id: 'TEXT' }, decorate: (c, p) => { AccessResource('hfp')(c); Owner()(p, 'owner_id'); } }, dialect);
        await new Promise((resolve) => setTimeout(resolve, 5));
        await contributor.contribute('root');
        expect((await log.coveredSince('column', 'hfp'))!.getTime()).to.be.greaterThan(first.getTime());
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
