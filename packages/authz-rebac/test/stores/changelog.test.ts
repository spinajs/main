import * as chai from 'chai';
import 'mocha';
import { changeLog } from '@spinajs/authz';
import { CHANGE_LOG_TABLE } from '@spinajs/authz-orm/changelog';
import { createHash } from 'node:crypto';

import { AUTHZ_REBAC_TUPLE_TABLE, DbTupleStore } from '../../src/index.js';
import { tupleKey } from '../../src/keys.js';
import { bootDb, rawQuery } from '../support/db.js';
import type { TestDb } from '../support/db.js';
import { d1, set, tuple, user } from '../support/world.js';

const expect = chai.expect;

const hash = (t: Parameters<typeof tupleKey>[0]) => createHash('sha256').update(tupleKey(t)).digest('hex');

describe('authz-rebac: DbTupleStore changelog (sqlite)', function () {
  this.timeout(60_000);
  let db: TestDb;

  before(async () => {
    db = await bootDb('tuple_changelog');
  });

  after(async () => {
    await db?.dispose();
  });

  beforeEach(async () => {
    await rawQuery(db.driver, `DELETE FROM ${AUTHZ_REBAC_TUPLE_TABLE}`);
    await rawQuery(db.driver, `DELETE FROM ${CHANGE_LOG_TABLE}`);
  });

  it('a DbTupleStore makes the tuple kind covered', () => {
    new DbTupleStore();
    expect(changeLog().covers('tuple')).to.equal(true);
  });

  it('records every tuple a write added or removed, and nothing for a no-op', async () => {
    const store = new DbTupleStore();
    const alice = tuple(d1, 'viewer', user('alice'));
    const eng = tuple(d1, 'viewer', set('group', 'eng', 'member'));
    await store.write([alice, eng], [], user('admin'));
    await store.write([alice], [eng, tuple(d1, 'viewer', user('nobody'))], user('root'));

    const rows = await changeLog().since(0);
    expect(rows.map((r) => [r.kind, r.op, r.key, r.actor])).to.deep.equal([
      ['tuple', 'add', hash(alice), 'user:admin'],
      ['tuple', 'add', hash(eng), 'user:admin'],
      ['tuple', 'remove', hash(eng), 'user:root'],
    ]);
    expect(rows[1].payload).to.deep.equal(eng);
  });

  it('a batched writeIn records each tuple it removed or added once, also for duplicates and remove-then-add', async () => {
    const store = new DbTupleStore();
    const viewer = (name: string) => tuple(d1, 'viewer', user(name));
    await store.write(['a', 'b', 'c'].map(viewer), [], user('admin'));
    const before = (await changeLog().since(0)).length;
    await db.driver.transaction((tx) => store.writeIn({ driver: tx }, ['a', 'b', 'c', 'd', 'd', 'e', 'f'].map(viewer), ['a', 'a', 'b', 'nobody'].map(viewer), user('root')));

    const rows = (await changeLog().since(0)).slice(before);
    const entry = (op: string, name: string) => [op, hash(viewer(name)), 'user:root'];
    expect(rows.map((r) => [r.op, r.key, r.actor])).to.deep.equal([entry('remove', 'a'), entry('remove', 'b'), ...['a', 'b', 'd', 'e', 'f'].map((n) => entry('add', n))]);
  });

  it('a rolled-back writeIn records nothing', async () => {
    const store = new DbTupleStore();
    await db.driver
      .transaction(async (tx) => {
        await store.writeIn({ driver: tx }, [tuple(d1, 'viewer', user('alice'))], [], user('admin'));
        throw new Error('roll back');
      })
      .catch(() => undefined);
    expect(await changeLog().since(0)).to.deep.equal([]);
  });
});
