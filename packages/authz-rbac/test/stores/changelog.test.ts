import * as chai from 'chai';
import 'mocha';

import { changeLog } from '@spinajs/authz';
import type { AuthzTx, PrincipalRef, ResourceRef } from '@spinajs/authz';
import { CHANGE_LOG_TABLE } from '@spinajs/authz-orm/changelog';
import { QueryContext } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';

import { DbAssignmentStore, DbMembershipStore, DbRuleStore } from '../../src/index.js';
import { bootDb, DB_KINDS, rawQuery } from '../support/db.js';
import type { TestDb } from '../support/db.js';

const expect = chai.expect;

const P1: ResourceRef = { type: 'project', id: 'p1' };
const P2: ResourceRef = { type: 'project', id: 'p2' };
const alice: PrincipalRef = { type: 'user', id: 'alice' };
const root: PrincipalRef = { type: 'user', id: 'root' };
const g1Members = { set: { role: 'group.member', scope: { type: 'group', id: 'g1' } } };

const TABLES = ['authz_assignment', 'authz_rule_subject', 'authz_rule', 'authz_subject_membership', 'authz_version', CHANGE_LOG_TABLE];

for (const kind of DB_KINDS) {
  describe(`RBAC DB stores changelog (${kind})`, function () {
    this.timeout(60000);

    let db: TestDb;
    let assignments: DbAssignmentStore;
    let rules: DbRuleStore;
    let memberships: DbMembershipStore;

    const inTx = <R>(fn: (tx: AuthzTx) => Promise<R>): Promise<R> => db.driver.transaction((driver: OrmDriver) => fn({ driver }));
    const changes = async () => (await changeLog().since(0)).map((c) => [c.kind, c.op, c.key, c.actor]);

    before(async function () {
      db = await bootDb(this, kind, 'rbac_changelog');
      assignments = db.container.resolve(DbAssignmentStore);
      rules = db.container.resolve(DbRuleStore);
      memberships = db.container.resolve(DbMembershipStore);
    });

    after(async () => {
      await db?.dispose();
    });

    beforeEach(async () => {
      for (const table of TABLES) await rawQuery(db.driver, `DELETE FROM ${table}`, [], QueryContext.Delete);
    });

    it('the DB stores make their kinds covered', () => {
      for (const k of ['assignment', 'rule', 'membership'] as const) expect(changeLog().covers(k)).to.eq(true);
    });

    it('logs grants, updates and revocations of assignments with their ids', async () => {
      const a = await inTx((tx) => assignments.assign({ subject: alice, role: 'editor', scope: P1, tags: [] }, root, tx));
      await inTx((tx) => assignments.assign({ subject: alice, role: 'editor', scope: P1, tags: ['x'] }, root, tx));
      await inTx((tx) => assignments.setTags(a.id, ['y'], tx));
      await inTx((tx) => assignments.update(a.id, { expiresAt: new Date('2030-01-01T00:00:00.000Z') }, alice, tx));
      await inTx((tx) => assignments.revoke(a.id, root, tx));

      expect(await changes()).to.deep.eq([
        ['assignment', 'add', a.id, 'user:root'],
        ['assignment', 'put', a.id, 'user:root'],
        ['assignment', 'put', a.id, 'unattended:unattended'],
        ['assignment', 'put', a.id, 'user:alice'],
        ['assignment', 'remove', a.id, 'user:root'],
      ]);
      const [added, , tagged] = await changeLog().since(0);
      expect(added.payload).to.deep.include({ id: a.id, role: 'editor', scope: P1, subject: alice });
      expect(tagged.payload).to.deep.include({ tags: ['y'] });
    });

    it('logs one removal per row a bulk revocation deleted', async () => {
      const a = await inTx((tx) => assignments.assign({ subject: alice, role: 'editor', scope: P1, tags: [] }, root, tx));
      const b = await inTx((tx) => assignments.assign({ subject: alice, role: 'viewer', scope: P2, tags: [] }, root, tx));
      const seq = (await changeLog().since(0)).at(-1)!.seq;
      await inTx((tx) => assignments.revokeSubjects([alice], tx));

      expect((await changeLog().since(seq)).map((c) => [c.op, c.key]).sort()).to.deep.eq(
        [
          ['remove', a.id],
          ['remove', b.id],
        ].sort(),
      );
    });

    it('a rolled-back batch logs nothing', async () => {
      await inTx(async (tx) => {
        await assignments.assign({ subject: alice, role: 'editor', scope: P1, tags: [] }, root, tx);
        throw new Error('roll back');
      }).catch(() => undefined);
      expect(await changes()).to.deep.eq([]);
    });

    it('logs rule writes and removals', async () => {
      await inTx((tx) => rules.put({ id: 'r1', kind: 'restrict', scope: P1, allow: [alice] }, root, tx));
      await inTx((tx) => rules.put({ id: 'r1', kind: 'restrict', scope: P1, allow: [alice, g1Members] }, root, tx));
      await inTx((tx) => rules.remove('r1', tx));

      expect(await changes()).to.deep.eq([
        ['rule', 'add', 'r1', 'user:root'],
        ['rule', 'put', 'r1', 'user:root'],
        ['rule', 'remove', 'r1', 'unattended:unattended'],
      ]);
      expect((await changeLog().since(0))[1].payload).to.deep.include({ id: 'r1', kind: 'restrict', allow: [alice, g1Members] });
    });

    it('forgetting a scope logs its rules as removed and the rules that lost a subject as changed', async () => {
      const g1 = { type: 'group', id: 'g1' };
      await inTx((tx) => rules.put({ id: 'at-g1', kind: 'restrict', scope: g1, allow: [alice] }, root, tx));
      await inTx((tx) => rules.put({ id: 'names-g1', kind: 'restrict', scope: P1, allow: [alice, g1Members] }, root, tx));
      const seq = (await changeLog().since(0)).at(-1)!.seq;
      await inTx((tx) => rules.forgetScopeEntries(g1, tx));

      const after = await changeLog().since(seq);
      expect(after.map((c) => [c.op, c.key])).to.deep.eq([
        ['remove', 'at-g1'],
        ['put', 'names-g1'],
      ]);
      expect(after[1].payload).to.deep.include({ allow: [alice] });
    });

    it('logs the closure rows a membership refresh wrote for a member', async () => {
      const rows = [{ memberKey: 'user:alice', setKey: 'group.member@group:g1', depth: 1, expiresAt: null }];
      await inTx((tx) => memberships.replace('user:alice', rows, tx));
      await inTx((tx) => memberships.replace('user:alice', [], tx));

      const logged = await changeLog().since(0);
      expect(logged.map((c) => [c.kind, c.op, c.key])).to.deep.eq([
        ['membership', 'put', 'user:alice'],
        ['membership', 'remove', 'user:alice'],
      ]);
      expect(logged[0].payload).to.deep.eq(rows);
    });
  });
}
