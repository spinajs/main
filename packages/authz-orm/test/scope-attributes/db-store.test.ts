import * as chai from 'chai';
import 'mocha';
import '@spinajs/log';
import { DI } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { Orm } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { AuthzConfigError, GLOBAL, ScopeAttributeStore, WritableScopeAttributeStore } from '@spinajs/authz';
import type { AuthzTx, ResourceRef } from '@spinajs/authz';

import { AuthzScopeAttribute_2026_10_02_00_00_00, DbScopeAttributeStore } from '../../src/index.js';

const expect = chai.expect;

const TABLE = 'authz_scope_attribute';
const ALICE = { type: 'user', id: 'alice' };
const o1: ResourceRef = { type: 'org', id: 'o1' };
const o2: ResourceRef = { type: 'org', id: 'o2' };

class DbConfig extends FrameworkConfiguration {
  protected onLoad(): unknown {
    return {
      logger: {
        targets: [{ name: 'Empty', type: 'BlackHoleTarget' }],
        rules: [{ name: '*', level: 'trace', target: 'Empty' }],
      },
      db: {
        DefaultConnection: 'sqlite',
        Connections: [{ Driver: 'orm-driver-sqlite', Filename: ':memory:', Name: 'sqlite', Migration: { Table: 'orm_migrations', OnStartup: true } }],
      },
    };
  }
}

async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected a rejection');
}

describe('DbScopeAttributeStore on SQLite', function () {
  this.timeout(30000);

  let orm: Orm;
  let db: OrmDriver;
  let config: Configuration;
  const store = new DbScopeAttributeStore();

  /** fn inside a real ORM transaction; `fail` rolls it back. */
  async function inTx<T>(fn: (tx: AuthzTx) => Promise<T>, fail = false): Promise<T | undefined> {
    try {
      return await db.transaction(async (d) => {
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
    (await db
      .select()
      .from(TABLE)
      .where({ scope_type: ref.type, scope_id: ref.id ?? '' })) as Record<string, unknown>[];

  before(async () => {
    DI.register(DbConfig).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
    config = (await DI.resolve(Configuration)) as Configuration;
    orm = (await DI.resolve(Orm)) as Orm;
    db = orm.Connections.get('default')!;
  });

  after(async () => {
    for (const c of new Set(orm.Connections.values())) await c.disconnect();
    DI.uncache(Orm);
    DI.uncache(Configuration);
    DI.unregister(DbConfig);
    DI.unregister(SqliteOrmDriver);
  });

  beforeEach(async () => {
    await db.del().from(TABLE);
    config.set(['authz', 'admin', 'connection'], undefined);
  });

  it('the migration registers through @Migration and creates the table at startup', async () => {
    expect(orm.Migrations.map((m) => m.name)).to.include(AuthzScopeAttribute_2026_10_02_00_00_00.name);
    const info = await db.tableInfo(TABLE);
    expect(info.map((c) => c.Name).sort()).to.deep.equal(['path', 'scope_id', 'scope_type', 'updated_at', 'updated_by', 'value_json', 'value_num', 'value_text']);
    expect(info.filter((c) => c.PrimaryKey).map((c) => c.Name)).to.deep.equal(['scope_type', 'scope_id', 'path']);
  });

  it('is a WritableScopeAttributeStore', () => {
    expect(store).to.be.instanceOf(WritableScopeAttributeStore);
    expect(store).to.be.instanceOf(ScopeAttributeStore);
  });

  it('writes, reads rows and rebuilds the nested object, with typed copies', async () => {
    const n = await inTx((tx) => store.write(o1, { set: { 'policies.level': 'gold', 'policies.limit': 3.5, 'policies.on': false }, remove: [] }, ALICE, tx));
    expect(n).to.equal(3);
    expect(await store.rows(o1)).to.deep.equal({ 'policies.level': 'gold', 'policies.limit': 3.5, 'policies.on': false });
    expect(await store.get(o1)).to.deep.equal({ policies: { level: 'gold', limit: 3.5, on: false } });
    expect(await store.get(o2)).to.deep.equal({});
    const rows = Object.fromEntries((await raw(o1)).map((r) => [r.path, r]));
    expect(rows['policies.level']).to.deep.include({ value_json: '"gold"', value_text: 'gold', value_num: null, updated_by: 'user:alice' });
    expect(rows['policies.limit']).to.deep.include({ value_json: '3.5', value_text: null, value_num: 3.5 });
    expect(rows['policies.on']).to.deep.include({ value_json: 'false', value_text: null, value_num: null });
    expect(rows['policies.on'].updated_at).to.not.equal(null);
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
    const global = (await db.select().from(TABLE).where({ scope_type: '$global' })) as Record<string, unknown>[];
    expect(global.map((r) => [r.scope_id, r.path])).to.deep.equal([['', 'g']]);
    expect(await store.get(GLOBAL)).to.deep.equal({ g: 1 });
    expect(await store.get(o2)).to.deep.equal({ o: 2 });
  });

  it('forget removes every row of the node', async () => {
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
    expect(await store.rows({ type: '$version', id: '' }).catch((e: Error) => e)).to.be.instanceOf(AuthzConfigError);
  });

  it('writes only inside an ORM transaction', async () => {
    for (const tx of [{ driver: {} }, { driver: db }, { driver: undefined }] as AuthzTx[]) {
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

  it('a row that holds no scalar fails the read', async () => {
    await db.insert().into(TABLE).values({ scope_type: 'org', scope_id: 'o1', path: 'bad', value_json: '[1]', updated_at: new Date() });
    expect(await rejection(store.get(o1))).to.be.instanceOf(AuthzConfigError);
  });

  it('reads on the connection authz.admin.connection names', async () => {
    config.set(['authz', 'admin', 'connection'], 'sqlite');
    await inTx((tx) => store.write(o1, { set: { a: 1 }, remove: [] }, ALICE, tx));
    expect(await store.rows(o1)).to.deep.equal({ a: 1 });
    config.set(['authz', 'admin', 'connection'], 'nope');
    const e = await rejection(store.rows(o1));
    expect(e).to.be.instanceOf(AuthzConfigError);
    expect(e.message).to.contain('authz.admin.connection');
    expect(await new DbScopeAttributeStore({ connection: 'sqlite' }).rows(o1)).to.deep.equal({ a: 1 });
  });
});
