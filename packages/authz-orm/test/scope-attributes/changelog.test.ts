import * as chai from 'chai';
import 'mocha';

import { changeLog } from '@spinajs/authz';
import type { AuthzTx, ChangeRecord, ResourceRef } from '@spinajs/authz';
import type { OrmDriver } from '@spinajs/orm';
import { createHash } from 'node:crypto';

import { DbScopeAttributeStore, attributeChangeKey } from '../../src/index.js';
import { TestDb } from '../support/db.js';
import type { Dialect } from '../support/db.js';
import { createScopeAttributeTables, dropScopeAttributeTables } from '../support/scope-attributes.js';

const expect = chai.expect;

const ALICE = { type: 'user', id: 'alice' };
const o1: ResourceRef = { type: 'org', id: 'o1' };

const keyOf = (scope: string, path: string) => createHash('sha256').update(`${scope}\u0000${path}`).digest('hex');
const leaf = (path: string, value: unknown) => ({ scope: 'org:o1', path, value });
const shape = (c: ChangeRecord) => [c.op, c.key, c.payload, c.before];

describe('DbScopeAttributeStore changelog', function () {
  this.timeout(60000);
  let db: TestDb;
  let pg = false;
  const store = new DbScopeAttributeStore();

  before(async () => {
    pg = await TestDb.postgresReachable();
    db = await TestDb.open({ postgres: pg });
  });

  after(async () => {
    await db?.close();
  });

  it('a DbScopeAttributeStore makes the attribute kind covered', () => {
    expect(changeLog().covers('attribute')).to.equal(true);
  });

  it('keys a leaf by the hash of its scope and path', () => {
    expect(attributeChangeKey(o1, 'a.b')).to.equal(keyOf('org:o1', 'a.b'));
    expect(attributeChangeKey(o1, 'a.b')).to.match(/^[0-9a-f]{64}$/);
  });

  for (const dialect of ['sqlite', 'postgres'] as const satisfies readonly Dialect[]) {
    describe(dialect, () => {
      let driver: OrmDriver;
      const inTx = <T>(fn: (tx: AuthzTx) => Promise<T>): Promise<T> => driver.transaction((d) => fn({ driver: d }));
      const loggedAfter = async (fn: () => Promise<unknown>) => {
        const seq = (await changeLog().since(0, { limit: 10000 })).at(-1)?.seq ?? 0;
        await fn();
        return changeLog().since(seq);
      };

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

      it('logs a fresh path as added, a replaced one as put with its old leaf and a removed one with its value', async () => {
        const created = await loggedAfter(() => inTx((tx) => store.write(o1, { set: { 'a.b': 0, c: 2 }, remove: [] }, ALICE, tx)));
        expect(created.map(shape)).to.have.deep.members([
          ['add', keyOf('org:o1', 'a.b'), leaf('a.b', 0), null],
          ['add', keyOf('org:o1', 'c'), leaf('c', 2), null],
        ]);
        expect(created.every((c) => c.kind === 'attribute' && c.actor === 'user:alice')).to.equal(true);

        const changed = await loggedAfter(() => inTx((tx) => store.write(o1, { set: { 'a.b': 1 }, remove: ['c'] }, ALICE, tx)));
        expect(changed.map(shape)).to.have.deep.members([
          ['put', keyOf('org:o1', 'a.b'), leaf('a.b', 1), leaf('a.b', 0)],
          ['remove', keyOf('org:o1', 'c'), leaf('c', 2), null],
        ]);
      });

      it('setting a path over a deeper one removes the deeper leaf and adds the new one', async () => {
        await inTx((tx) => store.write(o1, { set: { 'a.b': 0 }, remove: [] }, ALICE, tx));
        const logged = await loggedAfter(() => inTx((tx) => store.write(o1, { set: { a: 'x' }, remove: [] }, ALICE, tx)));
        expect(logged.map(shape)).to.have.deep.members([
          ['remove', keyOf('org:o1', 'a.b'), leaf('a.b', 0), null],
          ['add', keyOf('org:o1', 'a'), leaf('a', 'x'), null],
        ]);
      });

      it('a forget logs one removal per leaf with its value, and nothing for an empty node', async () => {
        await inTx((tx) => store.write(o1, { set: { 'p.level': 'gold', n: 3 }, remove: [] }, ALICE, tx));
        const logged = await loggedAfter(async () => {
          await inTx((tx) => store.forget(o1, tx));
          await inTx((tx) => store.forget({ type: 'org', id: 'empty' }, tx));
        });
        expect(logged.map(shape)).to.have.deep.members([
          ['remove', keyOf('org:o1', 'p.level'), leaf('p.level', 'gold'), null],
          ['remove', keyOf('org:o1', 'n'), leaf('n', 3), null],
        ]);
        expect(logged.every((c) => c.actor === 'unattended:unattended')).to.equal(true);
      });

      it('the before-image of a put is what the previous change of its key logged', async () => {
        await inTx((tx) => store.write(o1, { set: { x: true }, remove: [] }, ALICE, tx));
        await inTx((tx) => store.write(o1, { set: { x: false }, remove: [] }, ALICE, tx));
        await inTx((tx) => store.write(o1, { set: { x: 'on' }, remove: [] }, ALICE, tx));
        const [added, first, second] = await changeLog().since(0);
        expect(first.before).to.deep.equal(added.payload);
        expect(second.before).to.deep.equal(first.payload);
      });

      it('writes a node whose plain scope and path key would not fit the key column', async () => {
        const ref: ResourceRef = { type: 't'.repeat(64), id: 'i'.repeat(64) };
        const path = 'p'.repeat(160);
        const [row] = await loggedAfter(() => inTx((tx) => store.write(ref, { set: { [path]: 1 }, remove: [] }, ALICE, tx)));
        expect(`${'t'.repeat(64)}:${'i'.repeat(64)}\u0000${path}`.length).to.be.greaterThan(255);
        expect(row.key).to.equal(attributeChangeKey(ref, path));
        expect(row.payload).to.deep.equal({ scope: `${'t'.repeat(64)}:${'i'.repeat(64)}`, path, value: 1 });
      });

      it('a rolled-back write logs nothing', async () => {
        await inTx(async (tx) => {
          await store.write(o1, { set: { a: 1 }, remove: [] }, ALICE, tx);
          throw new Error('roll back');
        }).catch(() => undefined);
        expect(await changeLog().since(0)).to.deep.equal([]);
      });
    });
  }
});
