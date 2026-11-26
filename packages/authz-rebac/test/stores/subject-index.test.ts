import * as chai from 'chai';
import 'mocha';
import { AUTHZ_CONNECTION } from '@spinajs/authz';
import { QueryContext, extractMigrationDescriptor } from '@spinajs/orm';
import type { LiveIndex } from '@spinajs/orm';

import { AUTHZ_REBAC_TUPLE_TABLE, AuthzRebacSubjectIndex_2026_11_26_00_00_00, DbTupleStore } from '../../src/index.js';
import { DIALECTS, bootDb, rawQuery } from '../support/db.js';
import type { TestDb } from '../support/db.js';
import { d1, d2, ref, set, tuple, user } from '../support/world.js';

const expect = chai.expect;

const INDEX = 'authz_rebac_tuple_subject_object';

describe('authz-rebac: AuthzRebacSubjectIndex migration', () => {
  it('runs on the connection alias authz', () => {
    expect(extractMigrationDescriptor(AuthzRebacSubjectIndex_2026_11_26_00_00_00)?.Connection).to.equal(AUTHZ_CONNECTION);
  });

  for (const dialect of DIALECTS) {
    describe(dialect, function () {
      this.timeout(120_000);
      let db: TestDb;
      const store = new DbTupleStore();
      const migration = new AuthzRebacSubjectIndex_2026_11_26_00_00_00();
      const tuples = [tuple(d1, 'viewer', set('group', 'eng', 'member')), tuple(d2, 'parent', { type: 'folder', id: 'f1' }), tuple(d2, 'viewer', user('alice'))];

      const indexes = async (): Promise<LiveIndex[]> => (await db.driver.tableIndexes!(AUTHZ_REBAC_TUPLE_TABLE)).filter((i) => !i.primary);
      const subjectIndex = async () => (await indexes()).filter((i) => i.name === INDEX);
      const rowCount = async () => Number(((await rawQuery(db.driver, `SELECT COUNT(*) AS n FROM ${AUTHZ_REBAC_TUPLE_TABLE}`)) as { n: number | string }[])[0].n);

      before(async function () {
        db = await bootDb('subject_index', this, dialect);
      });

      after(async () => {
        await db?.dispose();
      });

      it('a fresh database gets the index on (subject_type, subject_id)', async () => {
        expect(await subjectIndex()).to.deep.equal([{ name: INDEX, columns: ['subject_type', 'subject_id'], unique: false, primary: false }]);
      });

      it('down drops only that index; up on a table with rows adds it back; up again finds it present', async () => {
        await store.write(tuples, [], user('admin'));
        const before = await indexes();

        await migration.down(db.driver);
        expect(await indexes()).to.deep.equal(before.filter((i) => i.name !== INDEX));
        expect(await rowCount()).to.equal(3);

        await migration.up(db.driver);
        expect(await indexes()).to.deep.equal(before);
        await migration.up(db.driver);
        expect(await indexes()).to.deep.equal(before);

        expect(await rowCount()).to.equal(3);
        expect(await store.withSubjectObject(ref('group', 'eng'))).to.deep.equal([tuples[0]]);
      });

      it('down without the index does nothing; up then builds it', async () => {
        await migration.down(db.driver);
        await migration.down(db.driver);
        expect(await subjectIndex()).to.deep.equal([]);
        await migration.up(db.driver);
        expect(await subjectIndex()).to.have.length(1);
      });

      if (dialect === 'postgres') {
        it('the catalog holds the index on exactly these columns of authz_rebac_tuple', async () => {
          const rows = (await rawQuery(db.driver, `SELECT tablename, indexdef FROM pg_indexes WHERE indexname = ?`, [INDEX])) as { tablename: string; indexdef: string }[];
          expect(rows).to.have.length(1);
          expect(rows[0].tablename).to.equal(AUTHZ_REBAC_TUPLE_TABLE);
          expect(rows[0].indexdef).to.match(/USING btree \(subject_type, subject_id\)$/);
        });

        it('an index an operator built by hand with CONCURRENTLY is found present', async () => {
          await migration.down(db.driver);
          await rawQuery(db.driver, `CREATE INDEX CONCURRENTLY ${INDEX} ON ${AUTHZ_REBAC_TUPLE_TABLE} (subject_type, subject_id)`, [], QueryContext.Schema);
          await migration.up(db.driver);
          expect(await subjectIndex()).to.have.length(1);
        });

        it('up refuses an invalid index of that name (a failed CONCURRENTLY build) and builds it once it is dropped', async () => {
          const valid = async () => ((await rawQuery(db.driver, `SELECT indisvalid FROM pg_index WHERE indexrelid = ?::regclass`, [INDEX])) as { indisvalid: boolean }[])[0]?.indisvalid;
          await rawQuery(db.driver, `UPDATE pg_index SET indisvalid = false WHERE indexrelid = ?::regclass`, [INDEX], QueryContext.Update);
          expect(await valid()).to.equal(false);

          let error: Error | undefined;
          await migration.up(db.driver).catch((err: Error) => (error = err));
          expect(error?.message).to.contain(`${INDEX} exists but is INVALID`).and.to.contain(`DROP INDEX CONCURRENTLY ${INDEX};`);

          await migration.down(db.driver);
          await migration.up(db.driver);
          expect(await subjectIndex()).to.have.length(1);
          expect(await valid()).to.equal(true);
        });
      }
    });
  }
});
