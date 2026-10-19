import * as chai from 'chai';
import 'mocha';

import { AuthzConfigError, GLOBAL, ScopeAttributeStore, WritableScopeAttributeStore } from '@spinajs/authz';
import type { AuthzTx, ResourceRef } from '@spinajs/authz';
import { DI } from '@spinajs/di';
import { DeleteQueryBuilder, InsertQueryBuilder, MIGRATION_DESCRIPTION_SYMBOL, SelectQueryBuilder, UpdateQueryBuilder } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';

import { AuthzScopeAttribute_2026_10_02_00_00_00, DbScopeAttributeStore } from '../../src/index.js';
import { TestDb } from '../support/db.js';
import type { Dialect } from '../support/db.js';
import { createScopeAttributeTables, dropScopeAttributeTables } from '../support/scope-attributes.js';

const expect = chai.expect;

const TABLE = 'authz_scope_attribute';
const VERSION_TABLE = 'authz_scope_attribute_version';
const ALICE = { type: 'user', id: 'alice' };
const o1: ResourceRef = { type: 'org', id: 'o1' };
const o2: ResourceRef = { type: 'org', id: 'o2' };

async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected a rejection');
}

/** A decimal column as a number: drivers return it as a number or as text. */
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/** The kind of every statement `driver` executes while `fn` runs. */
async function statements(driver: OrmDriver, fn: () => Promise<unknown>): Promise<string[]> {
  const seen: string[] = [];
  const spied = driver as unknown as { execute(builder: unknown): Promise<unknown> };
  const original = spied.execute;
  spied.execute = function (this: unknown, builder: unknown) {
    seen.push(builder instanceof UpdateQueryBuilder ? 'update' : builder instanceof DeleteQueryBuilder ? 'delete' : builder instanceof InsertQueryBuilder ? 'insert' : builder instanceof SelectQueryBuilder ? 'select' : 'other');
    return original.call(this, builder);
  };
  try {
    await fn();
  } finally {
    delete (spied as unknown as Record<string, unknown>).execute;
  }
  return seen;
}

describe('DbScopeAttributeStore', function () {
  this.timeout(60000);
  let db: TestDb;
  let pg = false;
  const store = new DbScopeAttributeStore();

  before(async () => {
    pg = await TestDb.postgresReachable();
    db = await TestDb.open({ postgres: pg, other: true });
  });

  after(async () => {
    await db?.close();
  });

  it('the migration is registered on the authz connection', () => {
    expect(DI.getRegisteredTypes('__migrations__')).to.include(AuthzScopeAttribute_2026_10_02_00_00_00);
    expect((AuthzScopeAttribute_2026_10_02_00_00_00 as unknown as Record<symbol, { Connection: string }>)[MIGRATION_DESCRIPTION_SYMBOL].Connection).to.equal('authz');
  });

  it('is a WritableScopeAttributeStore', () => {
    expect(store).to.be.instanceOf(WritableScopeAttributeStore);
    expect(store).to.be.instanceOf(ScopeAttributeStore);
  });

  for (const dialect of ['sqlite', 'postgres'] as const satisfies readonly Dialect[]) {
    describe(dialect, () => {
      let driver: OrmDriver;

      /** fn inside a real ORM transaction; `fail` rolls it back. */
      async function inTx<T>(fn: (tx: AuthzTx) => Promise<T>, fail = false): Promise<T | undefined> {
        try {
          return await driver.transaction(async (d) => {
            const out = await fn({ driver: d });
            if (fail) throw new Error('roll back');
            return out;
          });
        } catch (e) {
          if (!fail) throw e;
          return undefined;
        }
      }

      const raw = async (ref: ResourceRef) =>
        (await driver
          .select()
          .from(TABLE)
          .where({ scope_type: ref.type, scope_id: ref.id ?? '' })) as Record<string, unknown>[];

      before(function () {
        if (dialect === 'postgres' && !pg) this.skip();
      });

      beforeEach(async () => {
        driver = db.driver(dialect);
        await createScopeAttributeTables(db, dialect);
      });

      afterEach(async () => {
        await dropScopeAttributeTables(db, dialect);
      });

      it('the migration creates the table with its key and seeds one version row', async () => {
        const info = await driver.tableInfo(TABLE, driver.Options.Database);
        expect(info.map((c) => c.Name).sort()).to.deep.equal(['path', 'scope_id', 'scope_type', 'updated_at', 'updated_by', 'value_json', 'value_num', 'value_text']);
        expect(info.filter((c) => c.PrimaryKey).map((c) => c.Name).sort()).to.deep.equal(['path', 'scope_id', 'scope_type']);
        expect(((await driver.select().from(VERSION_TABLE)) as unknown[]).length).to.equal(1);
      });

      it('writes, reads rows and rebuilds the nested object, with typed copies', async () => {
        const n = await inTx((tx) => store.write(o1, { set: { 'policies.level': 'gold', 'policies.limit': 3.5, 'policies.on': false, 'n.neg': -2, 'n.big': 1e15 }, remove: [] }, ALICE, tx));
        expect(n).to.equal(5);
        await inTx((tx) => store.write(o1, { set: {}, remove: ['n'] }, ALICE, tx));
        expect(await store.rows(o1)).to.deep.equal({ 'policies.level': 'gold', 'policies.limit': 3.5, 'policies.on': false });
        expect(await store.get(o1)).to.deep.equal({ policies: { level: 'gold', limit: 3.5, on: false } });
        expect(await store.get(o2)).to.deep.equal({});
        const rows = Object.fromEntries((await raw(o1)).map((r) => [r.path, r]));
        expect(rows['policies.level']).to.deep.include({ value_json: '"gold"', value_text: 'gold', updated_by: 'user:alice' });
        expect(num(rows['policies.level'].value_num)).to.equal(null);
        expect(rows['policies.limit']).to.deep.include({ value_json: '3.5', value_text: '3.5' });
        expect(num(rows['policies.limit'].value_num)).to.equal(3.5);
        expect(rows['policies.on']).to.deep.include({ value_json: 'false', value_text: 'false' });
        expect(num(rows['policies.on'].value_num)).to.equal(null);
        expect(rows['policies.on'].updated_at).to.not.equal(null);
      });

      it('numbers keep value_num only while decimal(20,6) holds them', async () => {
        await inTx((tx) => store.write(o1, { set: { neg: -2.25, big: 1e15, edge: 99999999999999 }, remove: [] }, ALICE, tx));
        const rows = Object.fromEntries((await raw(o1)).map((r) => [r.path, r]));
        expect(rows.neg.value_text).to.equal('-2.25');
        expect(num(rows.neg.value_num)).to.equal(-2.25);
        expect(rows.big.value_text).to.equal('1000000000000000');
        expect(num(rows.big.value_num)).to.equal(null);
        expect(rows.edge.value_text).to.equal('99999999999999');
        expect(num(rows.edge.value_num)).to.equal(99999999999999);
        expect(await store.rows(o1)).to.deep.equal({ neg: -2.25, big: 1e15, edge: 99999999999999 });
      });

      it('a set path drops the rows above and below it', async () => {
        await inTx((tx) => store.write(o1, { set: { 'a.b': 1, 'a.c': 2, x: 1 }, remove: [] }, ALICE, tx));
        const n = await inTx((tx) => store.write(o1, { set: { a: 5, 'x.y': 2 }, remove: [] }, ALICE, tx));
        expect(n).to.equal(5);
        expect(await store.get(o1)).to.deep.equal({ a: 5, x: { y: 2 } });
      });

      it('writes and removes a node of many rows', async () => {
        const set = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`k.${i}`, `value ${i}`]));
        expect(await inTx((tx) => store.write(o1, { set, remove: [] }, ALICE, tx))).to.equal(1000);
        expect(Object.keys(await store.rows(o1))).to.have.length(1000);
        const again = Object.fromEntries(Object.keys(set).map((k) => [k, 1]));
        expect(await inTx((tx) => store.write(o1, { set: again, remove: [] }, ALICE, tx))).to.equal(1000);
        expect((await store.rows(o1))['k.999']).to.equal(1);
        expect(await inTx((tx) => store.write(o1, { set: {}, remove: ['k'] }, ALICE, tx))).to.equal(1000);
        expect(await raw(o1)).to.deep.equal([]);
      });

      it('a string longer than value_text keeps only its JSON', async () => {
        const long = 'x'.repeat(300);
        await inTx((tx) => store.write(o1, { set: { long }, remove: [] }, ALICE, tx));
        expect(await raw(o1)).to.have.length(1);
        expect((await raw(o1))[0]).to.deep.include({ value_text: null });
        expect(await store.rows(o1)).to.deep.equal({ long });
      });

      it('removes paths with everything below them, replaces set paths, and counts both', async () => {
        await inTx((tx) => store.write(o1, { set: { 'a.b': 1, 'a.c.d': 2, 'a.c.e': 3, ab: 4 }, remove: [] }, ALICE, tx));
        const n = await inTx((tx) => store.write(o1, { set: { 'a.b': 5, x: 'y' }, remove: ['a.c'] }, ALICE, tx));
        expect(n).to.equal(4);
        expect(await store.rows(o1)).to.deep.equal({ 'a.b': 5, ab: 4, x: 'y' });
      });

      it('stores GLOBAL as ($global, empty id) and keeps nodes apart', async () => {
        await inTx(async (tx) => {
          await store.write(GLOBAL, { set: { g: 1 }, remove: [] }, ALICE, tx);
          await store.write(o2, { set: { o: 2 }, remove: [] }, ALICE, tx);
        });
        const global = (await driver.select().from(TABLE).where({ scope_type: '$global' })) as Record<string, unknown>[];
        expect(global.map((r) => [r.scope_id, r.path])).to.deep.equal([['', 'g']]);
        expect(await store.get(GLOBAL)).to.deep.equal({ g: 1 });
        expect(await store.get(o2)).to.deep.equal({ o: 2 });
      });

      it('forget removes every row of the node and counts them', async () => {
        await inTx(async (tx) => {
          await store.write(o1, { set: { a: 1, 'b.c': 2 }, remove: [] }, ALICE, tx);
          await store.write(o2, { set: { a: 1 }, remove: [] }, ALICE, tx);
        });
        expect(await inTx((tx) => store.forget(o1, tx))).to.equal(2);
        expect(await store.rows(o1)).to.deep.equal({});
        expect(await store.rows(o2)).to.deep.equal({ a: 1 });
      });

      it('a rolled back ORM transaction leaves nothing, the version included', async () => {
        await inTx((tx) => store.write(o1, { set: { a: 1 }, remove: [] }, ALICE, tx));
        const v0 = await store.version();
        await inTx(async (tx) => {
          await store.write(o1, { set: { b: 2 }, remove: ['a'] }, ALICE, tx);
          await store.write(o2, { set: { c: 3 }, remove: [] }, ALICE, tx);
        }, true);
        expect(await store.rows(o1)).to.deep.equal({ a: 1 });
        expect(await store.rows(o2)).to.deep.equal({});
        expect(await store.version()).to.equal(v0);
      });

      it('the version changes on every write', async () => {
        const seen = new Set([await store.version()]);
        await inTx((tx) => store.write(o1, { set: { a: 1 }, remove: [] }, ALICE, tx));
        seen.add(await store.version());
        await inTx((tx) => store.write(o1, { set: { a: 1 }, remove: [] }, ALICE, tx));
        seen.add(await store.version());
        await inTx((tx) => store.forget(o1, tx));
        seen.add(await store.version());
        expect(seen.size).to.equal(4);
        // The counter lives in its own one-row table, updated in place; the data table holds data only.
        expect(((await driver.select().from(VERSION_TABLE)) as unknown[]).length).to.equal(1);
        expect(((await driver.select().from(TABLE)) as unknown[]).length).to.equal(0);
      });

      it('bumps the version before it reads or changes a node, so the version row lock queues writers', async () => {
        await inTx((tx) => store.write(o1, { set: { a: 1 }, remove: [] }, ALICE, tx));
        const write = await statements(driver, () => inTx((tx) => store.write(o1, { set: { a: 2, b: 1 }, remove: [] }, ALICE, tx)));
        const forget = await statements(driver, () => inTx((tx) => store.forget(o1, tx)));
        for (const seen of [write, forget]) {
          expect(seen[0], JSON.stringify(seen)).to.equal('update');
          expect(seen.filter((s) => s === 'update')).to.have.length(1);
        }
        expect(await store.rows(o1)).to.deep.equal({});
      });

      it('concurrent writes of one path both commit, one after the other', async () => {
        await inTx((tx) => store.write(o1, { set: { a: 1 }, remove: [] }, ALICE, tx));
        await Promise.all([2, 3].map((a) => inTx((tx) => store.write(o1, { set: { a }, remove: [] }, ALICE, tx))));
        expect([2, 3]).to.include((await store.rows(o1)).a);
        expect(await raw(o1)).to.have.length(1);
      });

      it('refuses a transaction on another connection than the records use', async () => {
        const e = await rejection(db.driver('other').transaction((d) => store.write(o1, { set: { a: 1 }, remove: [] }, ALICE, { driver: d })));
        expect(e).to.be.instanceOf(AuthzConfigError);
        expect(e.message).to.contain('db.Aliases.authz');
      });

      it('writes only inside an ORM transaction', async () => {
        for (const tx of [{ driver: {} }, { driver }, { driver: undefined }] as AuthzTx[]) {
          expect(await rejection(store.write(o1, { set: { a: 1 }, remove: [] }, ALICE, tx))).to.be.instanceOf(AuthzConfigError);
          expect(await rejection(store.forget(o1, tx))).to.be.instanceOf(AuthzConfigError);
        }
        expect(await raw(o1)).to.deep.equal([]);
      });

      it('refuses rows the table cannot hold', async () => {
        for (const set of [{ a: [1] }, { a: Number.NaN }, { ['p'.repeat(161)]: 1 }, { s: 'x'.repeat(1023) }]) {
          expect(await rejection(inTx((tx) => store.write(o1, { set: set as never, remove: [] }, ALICE, tx)))).to.be.instanceOf(AuthzConfigError);
        }
        expect(await rejection(inTx((tx) => store.write({ type: 'org', id: 'i'.repeat(65) }, { set: { a: 1 }, remove: [] }, ALICE, tx)))).to.be.instanceOf(AuthzConfigError);
      });

      it('a node whose type or id does not fit the columns has no rows: reads answer {}, forget 0, write refuses', async () => {
        const longs: ResourceRef[] = [
          { type: 'branch', id: 'i'.repeat(65) },
          { type: 't'.repeat(65), id: 'x' },
        ];
        for (const ref of longs) {
          const reads = await statements(driver, async () => {
            expect(await store.get(ref)).to.deep.equal({});
            expect(await store.rows(ref)).to.deep.equal({});
          });
          expect(reads, 'reads issue no query').to.deep.equal([]);
          const v0 = await store.version();
          expect(await inTx((tx) => store.forget(ref, tx))).to.equal(0);
          expect(await store.version()).to.equal(v0);
          expect(await rejection(inTx((tx) => store.write(ref, { set: { a: 1 }, remove: [] }, ALICE, tx)))).to.be.instanceOf(AuthzConfigError);
          expect(await store.version()).to.equal(v0);
        }
      });

      it('a malformed ref still fails the read and forget', async () => {
        for (const ref of [null, 'org', { type: '' }, { type: 'org', id: 5 }]) {
          expect(await rejection(store.get(ref as never))).to.be.instanceOf(AuthzConfigError);
          expect(await rejection(store.rows(ref as never))).to.be.instanceOf(AuthzConfigError);
          expect(await rejection(inTx((tx) => store.forget(ref as never, tx)))).to.be.instanceOf(AuthzConfigError);
        }
      });

      it('a type and id of 64 characters still fit', async () => {
        const ref: ResourceRef = { type: 't'.repeat(64), id: 'i'.repeat(64) };
        await inTx((tx) => store.write(ref, { set: { 'a.b': 1 }, remove: [] }, ALICE, tx));
        expect(await store.rows(ref)).to.deep.equal({ 'a.b': 1 });
        expect(await store.get(ref)).to.deep.equal({ a: { b: 1 } });
        expect(await inTx((tx) => store.forget(ref, tx))).to.equal(1);
        expect(await store.get(ref)).to.deep.equal({});
      });

      it('a row that holds no scalar, or no JSON, fails the read', async () => {
        await driver.insert().into(TABLE).values({ scope_type: 'org', scope_id: 'o1', path: 'bad', value_json: '[1]', updated_at: new Date() });
        expect(await rejection(store.get(o1))).to.be.instanceOf(AuthzConfigError);
        await driver.insert().into(TABLE).values({ scope_type: 'org', scope_id: 'o2', path: 'bad', value_json: 'gold', updated_at: new Date() });
        expect(await rejection(store.get(o2))).to.be.instanceOf(Error);
      });

      it('reads where db.Aliases.authz points; without the alias a read fails naming it', async () => {
        await inTx((tx) => store.write(o1, { set: { a: 1 }, remove: [] }, ALICE, tx));
        expect(await store.rows(o1)).to.deep.equal({ a: 1 });
        const authz = db.orm.Connections.get('authz')!;
        db.orm.Connections.delete('authz');
        try {
          for (const read of [() => store.rows(o1), () => store.version()]) {
            const e = await rejection(read());
            expect(e).to.be.instanceOf(AuthzConfigError);
            expect(e.message).to.contain('db.Aliases.authz');
          }
        } finally {
          db.orm.Connections.set('authz', authz);
        }
      });
    });
  }
});
