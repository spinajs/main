import * as chai from 'chai';
import 'mocha';
import { AsyncResource } from 'node:async_hooks';
import { AUTHZ_CONNECTION, AuthzAdminFailure, AuthzConfigError, SYSTEM } from '@spinajs/authz';
import type { AdminCallContext, AuthzCommand, AuthzService } from '@spinajs/authz';
import { DI } from '@spinajs/di';
import { ConcurrencyConflict } from '@spinajs/exceptions';
import { MIGRATION_DESCRIPTION_SYMBOL } from '@spinajs/orm';
import type { OrmDriver, QueryContext } from '@spinajs/orm';

import { fakeModelInitContext } from '@spinajs/authz-testing';

import { AUTHZ_REBAC_TUPLE_TABLE, AuthzRebacCaveats_2026_11_06_00_00_00, AuthzRebac_2026_10_21_00_00_00, CAVEAT_CONTEXT_MAX, DbTupleStore, RebacModel, RebacTupleHandler, TupleCaveatConflict, TupleStore, caveatKey } from '../../src/index.js';
import type { Tuple } from '../../src/index.js';
import { bootDb, rawQuery } from '../support/db.js';
import type { Dialect, TestDb } from '../support/db.js';
import { tupleStoreContract } from '../support/store-contract.js';
import { NAMESPACES, PERMISSIONS, PERMISSION_INPUTS, d1, d2, ref, set, tuple, user } from '../support/world.js';

const expect = chai.expect;

type Executor = { executeOnDb(stmt: string, params: unknown[], context: QueryContext): Promise<unknown> };

/** The SELECT statements `driver` runs during `work`. */
async function selectsDuring(driver: OrmDriver, work: () => Promise<unknown>): Promise<string[]> {
  const target = driver as unknown as Executor;
  const original = target.executeOnDb.bind(target);
  const selects: string[] = [];
  target.executeOnDb = (stmt, params, context) => {
    if (/^\s*select\b/i.test(stmt)) selects.push(stmt);
    return original(stmt, params, context);
  };
  try {
    await work();
  } finally {
    target.executeOnDb = original;
  }
  return selects;
}

describe('authz-rebac: AuthzRebac migration', () => {
  it('runs on the connection alias authz', () => {
    for (const migration of [AuthzRebac_2026_10_21_00_00_00, AuthzRebacCaveats_2026_11_06_00_00_00]) {
      expect((migration as unknown as Record<symbol, { Connection: string }>)[MIGRATION_DESCRIPTION_SYMBOL].Connection).to.equal(AUTHZ_CONNECTION);
    }
  });
});

describe('authz-rebac: DbTupleStore (sqlite)', function () {
  this.timeout(60_000);
  let db: TestDb;

  before(async () => {
    db = await bootDb('tuple_store');
  });

  after(async () => {
    await db?.dispose();
  });

  beforeEach(async () => {
    await rawQuery(db.driver, `DELETE FROM ${AUTHZ_REBAC_TUPLE_TABLE}`);
  });

  it('creates authz_rebac_tuple with the object and subject indexes', async () => {
    const indexes = (await rawQuery(db.driver, `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?`, [AUTHZ_REBAC_TUPLE_TABLE])) as { name: string }[];
    expect(indexes.map((i) => i.name)).to.include.members(['authz_rebac_tuple_object', 'authz_rebac_tuple_subject']);
    const columns = (await rawQuery(db.driver, `PRAGMA table_info(${AUTHZ_REBAC_TUPLE_TABLE})`)) as { name: string }[];
    expect(columns.map((c) => c.name)).to.have.members(['tuple_key', 'namespace', 'object_id', 'relation', 'subject_key', 'subject_type', 'subject_id', 'subject_relation', 'created_by', 'created_at', 'caveat', 'caveat_key', 'caveat_context']);
  });

  it('stores a caveat as its name, its key and its canonical context; an unconditional row keeps NULLs', async () => {
    const store = new DbTupleStore();
    const caveat = { name: 'not_expired', context: { 'env.until': 20, 'env.a': 'x' } };
    await store.write([{ ...tuple(d1, 'viewer', user('bob')), caveat }, tuple(d1, 'owner', user('bob'))], [], user('admin'));
    const rows = (await rawQuery(db.driver, `SELECT relation, caveat, caveat_key, caveat_context FROM ${AUTHZ_REBAC_TUPLE_TABLE} ORDER BY relation`)) as Record<string, unknown>[];
    expect(rows).to.deep.equal([
      { relation: 'owner', caveat: null, caveat_key: null, caveat_context: null },
      { relation: 'viewer', caveat: 'not_expired', caveat_key: caveatKey(caveat), caveat_context: '{"env.a":"x","env.until":20}' },
    ]);
  });

  it('refuses a caveat context longer than CAVEAT_CONTEXT_MAX before a transaction opens', async () => {
    const store = new DbTupleStore();
    let error: unknown;
    const selects = await selectsDuring(db.driver, async () => {
      try {
        await store.write([{ ...tuple(d1, 'viewer', user('bob')), caveat: { name: 'c', context: { 'env.big': 'x'.repeat(CAVEAT_CONTEXT_MAX) } } }], [], user('admin'));
      } catch (e) {
        error = e;
      }
    });
    expect(error).to.be.instanceOf(TypeError);
    expect(selects).to.deep.equal([]);
  });

  it('reads the stored rows in chunks, never one query per tuple', async () => {
    const store = new DbTupleStore();
    const absent = Array.from({ length: 600 }, (_, i) => tuple(d1, 'viewer', user(`u${i}`)));
    const selects = await selectsDuring(db.driver, () => db.driver.transaction((tx) => store.writeIn({ driver: tx }, [], absent, user('admin'))));
    expect(selects).to.have.length(2);
  });

  it('stores one row per tuple, with the subject key and the actor', async () => {
    const store = new DbTupleStore();
    await store.write([tuple(d1, 'viewer', set('group', 'eng', 'member')), tuple(d1, 'viewer', set('group', 'eng', 'member'))], [], user('admin'));
    const rows = (await rawQuery(db.driver, `SELECT namespace, object_id, relation, subject_key, subject_type, subject_id, subject_relation, created_by FROM ${AUTHZ_REBAC_TUPLE_TABLE}`)) as Record<string, unknown>[];
    expect(rows).to.deep.equal([{ namespace: 'doc', object_id: 'd1', relation: 'viewer', subject_key: 'group:eng#member', subject_type: 'group', subject_id: 'eng', subject_relation: 'member', created_by: 'user:admin' }]);
  });

  it('writeIn joins a transaction: a rollback undoes the write', async () => {
    const store = new DbTupleStore();
    const out = await db.driver
      .transaction(async (tx) => {
        const counts = await store.writeIn({ driver: tx }, [tuple(d1, 'viewer', user('alice')), tuple(d1, 'viewer', user('bob'))], [], user('admin'));
        expect(counts).to.deep.equal({ added: [tuple(d1, 'viewer', user('alice')), tuple(d1, 'viewer', user('bob'))], removed: [] });
        throw new Error('roll back');
      })
      .catch((e: Error) => e.message);
    expect(out).to.equal('roll back');
    expect(await store.read(d1, 'viewer')).to.deep.equal([]);
    await db.driver.transaction(async (tx) => {
      await store.writeIn({ driver: tx }, [tuple(d1, 'viewer', user('alice'))], [], user('admin'));
      expect(await store.writeIn({ driver: tx }, [tuple(d1, 'viewer', user('alice'))], [tuple(d1, 'viewer', user('nobody'))], user('admin'))).to.deep.equal({ added: [], removed: [] });
    });
    expect(await store.read(d1, 'viewer')).to.deep.equal([tuple(d1, 'viewer', user('alice'))]);
  });

  it('writeIn reads the stored keys once per side, not once per tuple, and keeps remove-then-add and duplicates', async () => {
    const store = new DbTupleStore();
    const viewer = (name: string) => tuple(d1, 'viewer', user(name));
    await store.write(['a', 'b', 'c'].map(viewer), [], user('admin'));
    let counts: unknown;
    const selects = await selectsDuring(db.driver, () =>
      db.driver.transaction(async (tx) => {
        counts = await store.writeIn({ driver: tx }, ['a', 'b', 'c', 'd', 'd', 'e', 'f'].map(viewer), ['a', 'a', 'b', 'nobody'].map(viewer), user('admin'));
      }),
    );
    expect(counts).to.deep.equal({ added: ['a', 'b', 'd', 'e', 'f'].map(viewer), removed: ['a', 'b'].map(viewer) });
    expect(selects).to.have.length(2);
    expect((await store.read(d1, 'viewer')).map((t) => (t.subject as { id: string }).id).sort()).to.deep.equal(['a', 'b', 'c', 'd', 'e', 'f']);
  });

  it('writeIn refuses a handle that is no transaction', async () => {
    const store = new DbTupleStore();
    let error: unknown;
    try {
      await store.writeIn({ driver: db.driver }, [tuple(d1, 'viewer', user('alice'))], [], user('admin'));
    } catch (e) {
      error = e;
    }
    expect(error).to.be.instanceOf(AuthzConfigError);
  });

  it('refuses a tuple wider than its columns', async () => {
    const store = new DbTupleStore();
    let error: unknown;
    try {
      await store.write([tuple(ref('doc', 'x'.repeat(200)), 'viewer', user('alice'))], [], user('admin'));
    } catch (e) {
      error = e;
    }
    expect(error).to.be.instanceOf(AuthzConfigError);
    expect((error as Error).message).to.include('object_id');
  });

  it('write refuses a tuple the namespaces of the RebacModel over it cannot hold, until the model is disposed', async () => {
    const store = new DbTupleStore();
    const model = new RebacModel({ store, namespaces: NAMESPACES, permissions: PERMISSIONS });
    await model.init(fakeModelInitContext({ permissions: PERMISSION_INPUTS, model: model.name, container: db.container }));
    const refusal = async (add: ReturnType<typeof tuple>): Promise<unknown> => {
      try {
        await store.write([add], [], user('admin'));
      } catch (e) {
        return e;
      }
      return undefined;
    };

    for (const bad of [tuple(d1, 'nosuch', user('alice')), tuple(ref('nosuch', 'x'), 'viewer', user('alice')), tuple(d1, 'owner', set('group', 'eng', 'member')), tuple(d1, 'read', user('alice'))]) {
      const error = await refusal(bad);
      expect(error, JSON.stringify(bad)).to.be.instanceOf(AuthzConfigError);
      expect((error as Error).message).to.include('add[0]');
    }
    expect(await rawQuery(db.driver, `SELECT tuple_key FROM ${AUTHZ_REBAC_TUPLE_TABLE}`)).to.deep.equal([]);

    await store.write([tuple(d1, 'viewer', user('alice'))], [tuple(d1, 'nosuch', user('alice'))], user('admin'));
    expect(await store.read(d1, 'viewer')).to.deep.equal([tuple(d1, 'viewer', user('alice'))]);

    await model.dispose();
    expect(await refusal(tuple(d1, 'nosuch', user('alice')))).to.equal(undefined);
  });
});

for (const dialect of ['sqlite', 'postgres', 'mysql'] as const satisfies readonly Dialect[]) {
  describe(`authz-rebac: DbTupleStore insert race (${dialect})`, function () {
    this.timeout(300_000);
    let db: TestDb;
    const store = new DbTupleStore();
    const bob = tuple(d1, 'viewer', user('bob'));
    const own = dialect !== 'sqlite';
    before(async function () {
      db = await bootDb('tuple_race', this, dialect);
    });
    after(async () => {
      await db?.dispose();
    });
    /** writeIn of `adds`, with `rival` stored after writeIn read the stored keys: on Postgres and MySQL in a committed transaction of its own; SQLite runs one transaction at a time, so there the rival joins it before the savepoint. */
    async function race(rival: Tuple, adds: readonly Tuple[]): Promise<unknown> {
      const outside = AsyncResource.bind(() => store.write([rival], [], user('rival')));
      const target = db.driver as unknown as Executor;
      const original = target.executeOnDb.bind(target);
      let fired = false;
      target.executeOnDb = async (stmt, params, context) => {
        if (!fired && (own ? /^\s*insert\b/i : /^\s*savepoint\b/i).test(stmt)) {
          fired = true;
          await (own ? outside() : store.writeIn({ driver: db.driver }, [rival], [], user('rival')));
        }
        return original(stmt, params, context);
      };
      try {
        return await db.driver.transaction((tx) => store.writeIn({ driver: tx }, adds, [], user('admin')));
      } catch (e) {
        return e;
      } finally {
        target.executeOnDb = original;
      }
    }
    it('a tuple stored meanwhile with the same caveat is a no-op, and the transaction goes on', async () => {
      const alice = tuple(d1, 'viewer', user('alice'));
      expect(await race(bob, [bob, alice])).to.deep.equal({ added: [alice], removed: [] });
      expect((await store.read(d1, 'viewer')).length).to.equal(2);
    });
    it('a tuple stored meanwhile with another caveat is a conflict', async () => {
      const t = tuple(d2, 'viewer', user('bob'));
      expect(await race({ ...t, caveat: { name: 'a' } }, [{ ...t, caveat: { name: 'b' } }])).to.be.instanceOf(TupleCaveatConflict);
      // On SQLite the rival wrote inside the transaction the conflict rolled back.
      expect(await store.read(d2, 'viewer')).to.deep.equal(own ? [{ ...t, caveat: { name: 'a' } }] : []);
    });
    if (dialect === 'postgres') {
      it('a tuple another writer stored after the snapshot of a REPEATABLE READ transaction fails the write with a request to retry', async () => {
        const fresh = ['rr0', 'rr1', 'rr2'].map((id) => tuple(d1, 'viewer', user(id)));
        const outside = AsyncResource.bind(() => store.write([fresh[1]], [], user('rival')));
        let error: unknown;
        await db.driver
          .transaction(
            async (tx) => {
              // The first read fixes the snapshot; the rival commits after it.
              await store.read(d1, 'viewer');
              await outside();
              error = await store.writeIn({ driver: tx }, fresh, [], user('admin')).catch((e: unknown) => e);
            },
            { isolation: 'REPEATABLE READ' },
          )
          .catch(() => undefined);
        expect(error).to.be.instanceOf(ConcurrencyConflict).with.property('message').that.matches(/stored by another transaction meanwhile .* retry the write$/);
        expect(error).not.to.be.instanceOf(TupleCaveatConflict);
      });
    }
  });
}

for (const pg of [false, true]) {
  describe(`authz-rebac: caveat_conflict through the tuple handler on DbTupleStore (${pg ? 'postgres' : 'sqlite'})`, function () {
    this.timeout(60_000);
    let db: TestDb;
    const store = new DbTupleStore();
    const handler = new RebacTupleHandler();
    const office = { name: 'office_ip' };
    const other = { name: 'office_ip', context: { 'env.ip': '10.0.0.9' } };
    const dave = (caveat?: Tuple['caveat']): Tuple => ({ ...tuple(d1, 'viewer', user('dave')), ...(caveat ? { caveat } : {}) });
    const erin = tuple(d1, 'viewer', user('erin'));
    before(async function () {
      db = await bootDb('tuple_admin', pg ? this : undefined);
    });
    after(async () => {
      await db?.dispose();
    });
    /** A batch the way AuthzAdmin runs it: every command in one transaction of the connection, which a failure rolls back. */
    async function batch(commands: readonly AuthzCommand[]): Promise<unknown> {
      const container = DI.child();
      container.register(() => store).as(TupleStore);
      const ctx: AdminCallContext = { domain: 'test', now: new Date(), authz: { models: () => [] } as unknown as AuthzService, actor: SYSTEM, container, dryRun: false };
      try {
        await db.driver.transaction(async (tx) => {
          for (const c of commands) await handler.apply(c, ctx, { driver: tx });
        });
        return undefined;
      } catch (e) {
        return e;
      }
    }
    it('another caveat is caveat_conflict and rolls the batch back; delete and write in one batch changes it', async () => {
      expect(await batch([{ kind: 'tuple.write', tuple: dave(office) }])).to.equal(undefined);
      const conflict = await batch([
        { kind: 'tuple.write', tuple: erin },
        { kind: 'tuple.write', tuple: dave(other) },
      ]);
      expect(conflict).to.be.instanceOf(AuthzAdminFailure).and.deep.include({ code: 'caveat_conflict', field: 'tuple.caveat' });
      expect(await store.read(d1, 'viewer')).to.deep.equal([dave(office)]);
      expect(
        await batch([
          { kind: 'tuple.delete', tuple: dave() },
          { kind: 'tuple.write', tuple: dave(other) },
        ]),
      ).to.equal(undefined);
      expect(await store.read(d1, 'viewer')).to.deep.equal([dave(other)]);
    });
  });
}

describe('authz-rebac: DbTupleStore contract (sqlite)', function () {
  this.timeout(60_000);
  let db: TestDb;

  before(async () => {
    db = await bootDb('tuple_contract');
  });

  after(async () => {
    await db?.dispose();
  });

  tupleStoreContract('DbTupleStore', async () => {
    await rawQuery(db.driver, `DELETE FROM ${AUTHZ_REBAC_TUPLE_TABLE}`);
    return new DbTupleStore();
  });
});
