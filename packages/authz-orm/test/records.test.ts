import * as chai from 'chai';
import 'mocha';

import { AuthzConfigError } from '@spinajs/authz';
import { ConnectionMismatch, NotAnOrmDriver, OrmConnectionMissing, TransactionRequired } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';
import { DateTime } from 'luxon';

import { AncestorRecord, ScopeAttributeRecord, ScopeAttributeVersionRecord } from '../src/index.js';
import { recordDriver, requireConnection, requireTransaction, selectFrom } from '../src/records.js';
import { createAncestorTable, dropAncestorTable } from './support/ancestors.js';
import { TestDb } from './support/db.js';
import type { Dialect } from './support/db.js';
import { createScopeAttributeTables, dropScopeAttributeTables } from './support/scope-attributes.js';

const expect = chai.expect;

function thrown(fn: () => unknown): Error {
  try {
    fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected a throw');
}

describe('authz-orm records', function () {
  this.timeout(60000);
  let db: TestDb;
  let pg = false;

  before(async () => {
    pg = await TestDb.postgresReachable();
    db = await TestDb.open({ postgres: pg, other: true });
  });

  after(async () => {
    await db?.close();
  });

  for (const dialect of ['sqlite', 'postgres'] as const satisfies readonly Dialect[]) {
    describe(dialect, () => {
      let driver: OrmDriver;

      before(function () {
        if (dialect === 'postgres' && !pg) this.skip();
      });

      beforeEach(async () => {
        driver = db.driver(dialect);
        await createAncestorTable(db, dialect);
        await createScopeAttributeTables(db, dialect);
      });

      afterEach(async () => {
        await dropScopeAttributeTables(db, dialect);
        await dropAncestorTable(db, dialect);
      });

      it('AncestorRecord writes and reads authz_resource_ancestor where the alias points', async () => {
        expect(recordDriver(AncestorRecord)).to.equal(driver);
        await AncestorRecord.insert([
          { resource_type: 'task', resource_id: '7', ancestor_type: 'project', ancestor_id: 'p1', depth: 1 },
          { resource_type: 'task', resource_id: '7', ancestor_type: 'org', ancestor_id: 'o1', depth: 2 },
        ]);
        const rows = await selectFrom(AncestorRecord).where('resource_type', 'task');
        expect(rows.map((r) => [r.ancestor_type, r.ancestor_id, r.depth]).sort()).to.deep.equal([
          ['org', 'o1', 2],
          ['project', 'p1', 1],
        ]);
        expect(rows.every((r) => r instanceof AncestorRecord && typeof r.depth === 'number')).to.equal(true);
        const { RowsAffected } = await AncestorRecord.destroy().where('resource_type', 'task').whereIn('ancestor_id', ['p1']);
        expect(RowsAffected).to.equal(1);
      });

      it('ScopeAttributeRecord keeps value_json as JSON text, null as SQL NULL, and reads the scalar back', async () => {
        const at = DateTime.now();
        await ScopeAttributeRecord.insert([
          { scope_type: '$global', scope_id: '', path: 's', value_json: 'gold', value_text: 'gold', value_num: null, updated_by: 'user:alice', updated_at: at },
          { scope_type: '$global', scope_id: '', path: 'n', value_json: 3.5, value_text: '3.5', value_num: 3.5, updated_by: null, updated_at: at },
          { scope_type: '$global', scope_id: '', path: 'b', value_json: false, value_text: 'false', value_num: null, updated_by: null, updated_at: at },
        ]);
        const raw = (await driver.select().from('authz_scope_attribute').columns(['path', 'value_json', 'value_num', 'updated_by'])) as { path: string; value_json: string; value_num: unknown; updated_by: unknown }[];
        expect(Object.fromEntries(raw.map((r) => [r.path, r.value_json]))).to.deep.equal({ s: '"gold"', n: '3.5', b: 'false' });
        expect(raw.filter((r) => r.value_num === null).map((r) => r.path).sort()).to.deep.equal(['b', 's']);
        expect(raw.filter((r) => r.updated_by === null).map((r) => r.path).sort()).to.deep.equal(['b', 'n']);
        const rows = await selectFrom(ScopeAttributeRecord).where({ scope_type: '$global', scope_id: '' });
        expect(Object.fromEntries(rows.map((r) => [r.path, r.value_json]))).to.deep.equal({ s: 'gold', n: 3.5, b: false });
        expect(rows.every((r) => DateTime.isDateTime(r.updated_at))).to.equal(true);
      });

      it('ScopeAttributeVersionRecord reads the row the migration seeds', async () => {
        const row = await selectFrom(ScopeAttributeVersionRecord).where('id', 1).first();
        expect(row.version).to.equal('0');
        expect(DateTime.isDateTime(row.updated_at)).to.equal(true);
      });
    });
  }

  describe('helpers', () => {
    beforeEach(async () => {
      await createAncestorTable(db, 'sqlite');
    });

    afterEach(async () => {
      await dropAncestorTable(db, 'sqlite');
    });

    it('requireTransaction wants an OrmDriver in a transaction on the record connection', async () => {
      const sqlite = db.driver('sqlite');
      const notADriver = thrown(() => requireTransaction(AncestorRecord, { driver: {} }, 'w'));
      expect(notADriver.message).to.equal('w: AuthzTx.driver must be the OrmDriver of an AuthzAdmin transaction');
      expect(notADriver.cause).to.be.instanceOf(NotAnOrmDriver);
      const noTransaction = thrown(() => requireTransaction(AncestorRecord, { driver: sqlite }, 'w'));
      expect(noTransaction.message).to.equal('w: stores write only inside an AuthzAdmin transaction, and none is in scope');
      expect(noTransaction.cause).to.be.instanceOf(TransactionRequired);
      await sqlite.transaction(async (d) => {
        expect(requireTransaction(AncestorRecord, { driver: d }, 'w')).to.equal(sqlite);
      });
      const e = await db.driver('other').transaction(async (d) => thrown(() => requireTransaction(AncestorRecord, { driver: d }, 'w')));
      expect(e).to.be.instanceOf(AuthzConfigError);
      expect(e.message).to.equal('w: the AuthzTx runs on connection "other", but authz_resource_ancestor is on connection "sqlite" (db.Aliases.authz)');
      expect(e.cause).to.be.instanceOf(ConnectionMismatch);
    });

    it('requireConnection returns the record driver and otherwise names both connections and the alias', () => {
      expect(requireConnection(AncestorRecord, db.driver('sqlite'), 'x')).to.equal(db.driver('sqlite'));
      const e = thrown(() => requireConnection(AncestorRecord, db.driver('other'), 'x'));
      expect(e).to.be.instanceOf(AuthzConfigError);
      expect(e.message).to.equal('x runs on connection "other", but authz_resource_ancestor is on connection "sqlite" (db.Aliases.authz)');
      expect(e.cause).to.be.instanceOf(ConnectionMismatch);
    });

    it('without the alias the wrappers fail with AuthzConfigError naming db.Aliases.authz, the ORM delete with OrmConnectionMissing', () => {
      const authz = db.orm.Connections.get('authz')!;
      db.orm.Connections.delete('authz');
      try {
        for (const fn of [() => recordDriver(AncestorRecord), () => selectFrom(AncestorRecord), () => requireConnection(AncestorRecord, db.driver('sqlite'), 'x')]) {
          const e = thrown(fn);
          expect(e).to.be.instanceOf(AuthzConfigError);
          expect(e.message).to.equal('AncestorRecord: no ORM connection answers to "authz"; set db.Aliases.authz');
          expect(e.cause).to.be.instanceOf(OrmConnectionMissing);
        }
        expect(() => AncestorRecord.destroy()).to.throw(OrmConnectionMissing);
      } finally {
        db.orm.Connections.set('authz', authz);
      }
    });
  });
});
