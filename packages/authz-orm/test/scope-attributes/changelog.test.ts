import * as chai from 'chai';
import 'mocha';

import { changeLog } from '@spinajs/authz';
import type { AuthzTx, ResourceRef } from '@spinajs/authz';
import type { OrmDriver } from '@spinajs/orm';

import { DbScopeAttributeStore } from '../../src/index.js';
import { TestDb } from '../support/db.js';
import { createScopeAttributeTables, dropScopeAttributeTables } from '../support/scope-attributes.js';

const expect = chai.expect;

const ALICE = { type: 'user', id: 'alice' };
const o1: ResourceRef = { type: 'org', id: 'o1' };

describe('DbScopeAttributeStore changelog (sqlite)', function () {
  this.timeout(60000);
  let db: TestDb;
  let driver: OrmDriver;
  const store = new DbScopeAttributeStore();

  const inTx = <T>(fn: (tx: AuthzTx) => Promise<T>): Promise<T> => driver.transaction((d) => fn({ driver: d }));

  before(async () => {
    db = await TestDb.open();
    driver = db.driver('sqlite');
  });

  after(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    await createScopeAttributeTables(db, 'sqlite');
  });

  afterEach(async () => {
    await dropScopeAttributeTables(db, 'sqlite');
  });

  it('a DbScopeAttributeStore makes the attribute kind covered', () => {
    expect(changeLog().covers('attribute')).to.equal(true);
  });

  it('logs each write of a node with what it set and removed, and a forget that removed rows', async () => {
    await inTx((tx) => store.write(o1, { set: { 'policies.level': 'gold', 'n.a': 1 }, remove: [] }, ALICE, tx));
    await inTx((tx) => store.write(o1, { set: { 'policies.level': 'silver' }, remove: ['n'] }, ALICE, tx));
    await inTx((tx) => store.forget(o1, tx));
    await inTx((tx) => store.forget({ type: 'org', id: 'empty' }, tx));

    const logged = await changeLog().since(0);
    expect(logged.map((c) => [c.kind, c.op, c.key, c.actor])).to.deep.equal([
      ['attribute', 'put', 'org:o1', 'user:alice'],
      ['attribute', 'put', 'org:o1', 'user:alice'],
      ['attribute', 'remove', 'org:o1', 'unattended:unattended'],
    ]);
    expect(logged[0].payload).to.deep.equal({ set: { 'policies.level': 'gold', 'n.a': 1 }, remove: [] });
    expect(logged[1].payload).to.deep.equal({ set: { 'policies.level': 'silver' }, remove: ['n.a'] });
  });

  it('a rolled-back write logs nothing', async () => {
    await inTx(async (tx) => {
      await store.write(o1, { set: { a: 1 }, remove: [] }, ALICE, tx);
      throw new Error('roll back');
    }).catch(() => undefined);
    expect(await changeLog().since(0)).to.deep.equal([]);
  });
});
