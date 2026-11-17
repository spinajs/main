import * as chai from 'chai';
import 'mocha';
import { changeLog } from '@spinajs/authz';
import type { AuthzTx } from '@spinajs/authz';
import { CHANGE_LOG_TABLE } from '@spinajs/authz-orm/changelog';
import { userPrincipal } from '@spinajs/authz-testing';
import { QueryContext } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';

import { AUTHZ_POLICY_TABLE, DbPolicyStore } from '../../src/index.js';
import { DB_KINDS, bootDb, rawQuery } from '../support/db.js';
import type { TestDb } from '../support/db.js';

const expect = chai.expect;

const NOW = new Date('2026-10-01T12:00:00.000Z');
const alice = userPrincipal('alice');

for (const kind of DB_KINDS) {
  describe(`DbPolicyStore changelog (${kind})`, function () {
    this.timeout(60000);
    let db: TestDb;
    const store = new DbPolicyStore();

    const write = <T>(fn: (tx: AuthzTx) => Promise<T>): Promise<T> => db.driver.transaction((driver: OrmDriver) => fn({ driver }));

    before(async function () {
      db = await bootDb(this, kind, 'policy_changelog');
    });

    after(async () => {
      await db?.dispose();
    });

    beforeEach(async () => {
      for (const table of [AUTHZ_POLICY_TABLE, CHANGE_LOG_TABLE]) await rawQuery(db.driver, `DELETE FROM ${table}`, [], QueryContext.Delete);
    });

    it('a DbPolicyStore makes the policy kind covered', () => {
      expect(changeLog().covers('policy')).to.equal(true);
    });

    it('logs a new policy, its replacement and its deletion, and nothing for deleting a missing one', async () => {
      await write((tx) => store.put({ id: 'p', effect: 'permit', permissions: ['file:read'] }, alice, tx, NOW));
      await write((tx) => store.put({ id: 'p', effect: 'deny', permissions: ['file:read'] }, undefined, tx, NOW));
      await write((tx) => store.delete('p', tx));
      await write((tx) => store.delete('missing', tx));

      const logged = await changeLog().since(0);
      expect(logged.map((c) => [c.kind, c.op, c.key, c.actor])).to.deep.equal([
        ['policy', 'add', 'p', 'user:alice'],
        ['policy', 'put', 'p', 'unattended:unattended'],
        ['policy', 'remove', 'p', 'unattended:unattended'],
      ]);
      expect(logged[0].at.toISOString()).to.equal(NOW.toISOString());
      expect(logged[1].payload).to.deep.include({ id: 'p', effect: 'deny', permissions: ['file:read'], source: 'db' });
    });

    it('a replaced policy logs what it replaced, and a deleted one what was deleted', async () => {
      await write((tx) => store.put({ id: 'p', effect: 'permit', permissions: ['file:read'], resourceTypes: ['file'], expiresAt: new Date('2030-01-01T00:00:00.000Z') }, alice, tx, NOW));
      await write((tx) => store.put({ id: 'p', effect: 'deny', permissions: ['file:read'], when: { attr: 'resource.status', eq: 'locked' }, fields: { hide: ['email'] }, priority: 5 }, undefined, tx, NOW));
      await write((tx) => store.delete('p', tx));

      const [added, put, removed] = await changeLog().since(0);
      expect(added.before).to.equal(null);
      expect(put.before).to.deep.equal(added.payload);
      expect(put.before).to.deep.include({ effect: 'permit', resourceTypes: ['file'] });
      expect(removed.payload).to.deep.equal(put.payload);
      expect(removed.before).to.equal(null);
    });

    it('a row whose JSON does not parse is still replaced and deleted, logged without its image', async () => {
      await write((tx) => store.put({ id: 'p', effect: 'permit', permissions: ['file:read'] }, alice, tx, NOW));
      await rawQuery(db.driver, `UPDATE ${AUTHZ_POLICY_TABLE} SET permissions = ? WHERE id = ?`, ['{not json', 'p'], QueryContext.Update);
      await write((tx) => store.put({ id: 'p', effect: 'deny', permissions: ['file:read'] }, undefined, tx, NOW));
      await rawQuery(db.driver, `UPDATE ${AUTHZ_POLICY_TABLE} SET permissions = ? WHERE id = ?`, ['{not json', 'p'], QueryContext.Update);
      await write((tx) => store.delete('p', tx));

      const [, put, removed] = await changeLog().since(0);
      expect([put.op, put.before]).to.deep.equal(['put', null]);
      expect([removed.op, removed.payload]).to.deep.equal(['remove', null]);
    });

    it('a rolled-back write logs nothing', async () => {
      await write(async (tx) => {
        await store.put({ id: 'p', effect: 'permit', permissions: ['file:read'] }, alice, tx, NOW);
        throw new Error('roll back');
      }).catch(() => undefined);
      expect(await changeLog().since(0)).to.deep.equal([]);
    });
  });
}
