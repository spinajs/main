import * as chai from 'chai';
import 'mocha';
import { AUTHZ_CONNECTION, AuthzConfigError } from '@spinajs/authz';
import { MIGRATION_DESCRIPTION_SYMBOL } from '@spinajs/orm';

import { fakeModelInitContext } from '@spinajs/authz-testing';

import { AUTHZ_REBAC_TUPLE_TABLE, AuthzRebac_2026_10_21_00_00_00, DbTupleStore, RebacModel } from '../../src/index.js';
import { bootDb, rawQuery } from '../support/db.js';
import type { TestDb } from '../support/db.js';
import { tupleStoreContract } from '../support/store-contract.js';
import { NAMESPACES, PERMISSIONS, PERMISSION_INPUTS, d1, ref, set, tuple, user } from '../support/world.js';

const expect = chai.expect;

describe('authz-rebac: AuthzRebac migration', () => {
  it('runs on the connection alias authz', () => {
    expect((AuthzRebac_2026_10_21_00_00_00 as unknown as Record<symbol, { Connection: string }>)[MIGRATION_DESCRIPTION_SYMBOL].Connection).to.equal(AUTHZ_CONNECTION);
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
    expect(columns.map((c) => c.name)).to.have.members(['tuple_key', 'namespace', 'object_id', 'relation', 'subject_key', 'subject_type', 'subject_id', 'subject_relation', 'created_by', 'created_at']);
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
        expect(counts).to.deep.equal({ added: 2, removed: 0 });
        throw new Error('roll back');
      })
      .catch((e: Error) => e.message);
    expect(out).to.equal('roll back');
    expect(await store.read(d1, 'viewer')).to.deep.equal([]);
    await db.driver.transaction(async (tx) => {
      await store.writeIn({ driver: tx }, [tuple(d1, 'viewer', user('alice'))], [], user('admin'));
      expect(await store.writeIn({ driver: tx }, [tuple(d1, 'viewer', user('alice'))], [tuple(d1, 'viewer', user('nobody'))], user('admin'))).to.deep.equal({ added: 0, removed: 0 });
    });
    expect(await store.read(d1, 'viewer')).to.deep.equal([tuple(d1, 'viewer', user('alice'))]);
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
    await model.init(fakeModelInitContext({ permissions: PERMISSION_INPUTS, model: model.name }));
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
