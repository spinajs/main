import * as chai from 'chai';
import 'mocha';

import { GLOBAL } from '@spinajs/authz';
import type { AuthzTx, ResourceRef } from '@spinajs/authz';
import { DI } from '@spinajs/di';
import { WriteObserver } from '@spinajs/orm';
import type { CaptureInterest, CapturedWrite, OrmDriver, WriteStatement } from '@spinajs/orm';

import { DbScopeAttributeStore, ScopeAttributeRecord, scopeAttributeId } from '../../src/index.js';
import { TestDb } from '../support/db.js';
import { createScopeAttributeTables, dropScopeAttributeTables } from '../support/scope-attributes.js';

const expect = chai.expect;

const ALICE = { type: 'user', id: 'alice' };
const O1: ResourceRef = { type: 'org', id: 'o1' };

// Module state, not instance state: the test does not depend on which instance DI hands the capture.
const seen: CapturedWrite[] = [];

class AttributeWrites extends WriteObserver {
  interest({ model }: WriteStatement): CaptureInterest | undefined {
    return model === ScopeAttributeRecord ? { columns: '*', transactional: true } : undefined;
  }

  async observe(write: CapturedWrite): Promise<void> {
    seen.push(write);
  }
}

const ids = (w: CapturedWrite): string[] => w.rows.map((r) => r.id).sort();

describe('DbScopeAttributeStore: writes reach the ORM write capture keyed by id', function () {
  this.timeout(60000);
  let db: TestDb;
  let driver: OrmDriver;
  const store = new DbScopeAttributeStore();
  const inTx = (fn: (tx: AuthzTx) => Promise<unknown>): Promise<unknown> => driver.transaction((d) => fn({ driver: d }));

  before(async () => {
    db = await TestDb.open();
    driver = db.driver('sqlite');
    DI.register(AttributeWrites).as(WriteObserver);
  });

  after(async () => {
    DI.unregister(AttributeWrites);
    await db?.close();
  });

  beforeEach(async () => {
    await createScopeAttributeTables(db, 'sqlite');
    seen.length = 0;
  });

  afterEach(async () => {
    await dropScopeAttributeTables(db, 'sqlite');
  });

  it('a write inserts its leaves under their ids', async () => {
    await inTx((tx) => store.write(O1, { set: { a: 1, 'b.c': 'x' }, remove: [] }, ALICE, tx));
    expect(seen.map((w) => w.kind)).to.deep.equal(['insert']);
    const [insert] = seen;
    expect(insert.unknownKeys).to.equal(false);
    expect(insert.keylessRows).to.equal(0);
    expect(ids(insert)).to.deep.equal([scopeAttributeId('org', 'o1', 'a'), scopeAttributeId('org', 'o1', 'b.c')].sort());
    const a = insert.rows.find((r) => r.id === scopeAttributeId('org', 'o1', 'a'));
    expect(a?.before).to.equal(undefined);
    expect(a?.after).to.include({ id: scopeAttributeId('org', 'o1', 'a'), scope_type: 'org', scope_id: 'o1', path: 'a', value_json: '1' });
  });

  it('a replaced leaf is deleted and inserted again under the same id', async () => {
    await inTx((tx) => store.write(O1, { set: { a: 1 }, remove: [] }, ALICE, tx));
    seen.length = 0;
    await inTx((tx) => store.write(O1, { set: { a: 2 }, remove: [] }, ALICE, tx));
    const id = scopeAttributeId('org', 'o1', 'a');
    expect(seen.map((w) => w.kind)).to.deep.equal(['delete', 'insert']);
    expect(seen.map(ids)).to.deep.equal([[id], [id]]);
    expect(seen[0].rows[0].before).to.include({ value_json: '1' });
    expect(seen[1].rows[0].after).to.include({ value_json: '2' });
  });

  it('a $global leaf and a forget are keyed the same way', async () => {
    await inTx((tx) => store.write(GLOBAL, { set: { g: true }, remove: [] }, ALICE, tx));
    await inTx((tx) => store.forget(GLOBAL, tx));
    const id = scopeAttributeId('$global', '', 'g');
    expect(seen.map((w) => w.kind)).to.deep.equal(['insert', 'delete']);
    expect(seen.map(ids)).to.deep.equal([[id], [id]]);
    expect(seen[0].rows[0].after).to.include({ scope_type: '$global', scope_id: '' });
  });
});
