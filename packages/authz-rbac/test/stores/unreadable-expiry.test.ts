import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';

import { AuthzConfigError, GLOBAL, PermissionRegistryImpl, TRUE, changeLog } from '@spinajs/authz';
import type { PrincipalRef, ResourceRef } from '@spinajs/authz';
import { FakeScopeResolver, fakeEvaluationContext, fakeModelInitContext, userPrincipal } from '@spinajs/authz-testing';
import { QueryContext } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';

import { DbAssignmentStore, MemoryRoleStore, RbacModel, subjectFromColumns, subjectKeyOf } from '../../src/index.js';
import type { LadderDef, RoleDef } from '../../src/index.js';
import type { Assignment, AssignmentSubject } from '../../src/contracts.js';
import { membershipEdges } from '../../src/admin/membership.js';
import { scopeToColumns, subjectToColumns } from '../../src/stores/columns.js';
import type { RoleIndex } from '../../src/admin/role-index.js';
import { expiryTime } from '../../src/model/assignments.js';
import { linkPrincipalOf } from '../../src/model/links/principal.js';
import { DbLinkStore } from '../../src/stores/db-link-store.js';
import { DbMembershipStore } from '../../src/stores/db-membership-store.js';
import { DbRuleStore } from '../../src/stores/db-rule-store.js';
import { bootDb, rawQuery } from '../support/db.js';
import type { TestDb } from '../support/db.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

// Before every unreadable value below in the database's own order, so the SQL filter keeps the rows as live.
const AT = new Date('2026-10-01T12:00:00.000Z');
const P1: ResourceRef = { type: 'project', id: 'p1' };
const alice: PrincipalRef = { type: 'user', id: 'alice' };
const bob: PrincipalRef = { type: 'user', id: 'bob' };

type Kind = 'sqlite' | 'postgres' | 'mysql';
/**
 * Per driver, a value of the column type that the datetime converter reads as null and that sorts after AT (SX-05
 * review, section 1), and other such values, some sorting before now, read by id.
 */
const DIALECTS: readonly { kind: Kind; unreadable: string; also: readonly string[] }[] = [
  { kind: 'sqlite', unreadable: "'not a date'", also: ["'now'", "'2026-13-01 00:00:00'"] },
  { kind: 'postgres', unreadable: "'infinity'", also: ["'-infinity'", "'294276-12-31 00:00:00'"] },
  { kind: 'mysql', unreadable: "'2026-12-00 00:00:00'", also: ["'0000-00-00 00:00:00'", "'2026-00-10 00:00:00'"] },
];

const keyOf = (p: PrincipalRef) => subjectKeyOf(subjectFromColumns(p.type, p.id, ''));
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

for (const { kind, unreadable, also } of DIALECTS) {
  describe(`RBAC stores: an expires_at no converter reads (${kind})`, function () {
    this.timeout(60000);

    let db: TestDb<Kind>;

    /** Inserts `columns` and an unreadable `expires_at`; MySQL's strict mode refuses a zero day, so the insert runs with the session mode relaxed on one connection. */
    const insertUnreadable = async (table: string, columns: Record<string, unknown>, value: string = unreadable): Promise<void> => {
      const sql = `INSERT INTO ${table} (${[...Object.keys(columns), 'expires_at'].join(', ')}) VALUES (${Object.keys(columns).map(() => '?').join(', ')}, ${value})`;
      if (kind !== 'mysql') {
        await rawQuery(db.driver, sql, Object.values(columns), QueryContext.Insert);
        return;
      }
      // a transaction holds one connection, so the session mode never leaks into the pool
      await db.driver.transaction(async () => {
        await rawQuery(db.driver, "SET SESSION sql_mode = ''", [], QueryContext.Update);
        try {
          await rawQuery(db.driver, sql, Object.values(columns), QueryContext.Insert);
        } finally {
          await rawQuery(db.driver, 'SET SESSION sql_mode = DEFAULT', [], QueryContext.Update);
        }
      });
    };

    const assignment = (id: string, p: PrincipalRef) => ({ id, subject_type: p.type, subject_id: p.id, subject_role: '', subject_key: keyOf(p), role: 'editor', scope_type: P1.type, scope_id: P1.id, tags: '', source: 'db', created_at: '2026-09-30 08:15:30' });

    before(async function () {
      // MySQL skips like the package's other MySQL suites; ORM_TEST_REQUIRE_MYSQL=1 turns a missing server into a failure.
      try {
        db = await bootDb(this, kind, `sx19_${kind}`);
      } catch (err) {
        if (kind === 'mysql' && process.env.ORM_TEST_REQUIRE_MYSQL === '1') throw new Error('ORM_TEST_REQUIRE_MYSQL=1 but MySQL at 127.0.0.1:13306 is unreachable', { cause: err });
        throw err;
      }
    });

    after(async () => {
      await db?.dispose();
    });

    it('gives an assignment an invalid expiry, which the model refuses, and leaves NULL as no expiry', async () => {
      await insertUnreadable('authz_assignment', assignment('a1', alice));
      await db.driver.insert().into('authz_assignment').values({ ...assignment('a2', bob), expires_at: null });
      const store = db.container.resolve(DbAssignmentStore);

      const rows = await store.forSubjects([alice], AT);
      expect(rows).to.have.length(1);
      expect(Number.isNaN(expiryTime(rows[0]))).to.equal(true);
      expect(Number.isNaN((await store.byId('a1'))!.expiresAt!.getTime())).to.equal(true);
      expect((await store.forSubjects([bob], AT)).map((a) => a.expiresAt)).to.deep.equal([null]);
    });

    it('reads every other unreadable spelling the dialect stores as an invalid expiry', async () => {
      const store = db.container.resolve(DbAssignmentStore);
      for (const [i, value] of also.entries()) {
        await insertUnreadable('authz_assignment', assignment(`x${i}`, { type: 'user', id: `x${i}` }), value);
        expect(Number.isNaN((await store.byId(`x${i}`))!.expiresAt!.getTime()), value).to.equal(true);
      }
    });

    it('logs such an assignment revoked by id with a null expiry, as the docs warn replay', async () => {
      const rita: PrincipalRef = { type: 'user', id: 'rita' };
      await insertUnreadable('authz_assignment', assignment('r1', rita));
      await db.driver.transaction((driver: OrmDriver) => db.container.resolve(DbAssignmentStore).revoke('r1', alice, { driver }));

      const removed = (await changeLog().since(0, { kinds: ['assignment'] })).filter((c) => c.key === 'r1');
      expect(removed.map((c) => c.op)).to.deep.equal(['remove']);
      expect(removed[0].payload).to.deep.include({ id: 'r1', expiresAt: null });
    });

    it('refuses a membership read that meets such a row, naming the member and the set', async () => {
      await insertUnreadable('authz_subject_membership', { member_key: keyOf(alice), set_key: '%set:["team.member","team:t1"]', depth: 1 });
      const store = db.container.resolve(DbMembershipStore);

      await expect(store.setsOf([keyOf(alice)], AT)).to.be.rejectedWith(AuthzConfigError, /authz_subject_membership.*user:alice/);
    });

    it('gives a rule an invalid expiry, on the path and in the admin listing', async () => {
      // `file-grant-cap` of test/support/rules.ts (CANVAS_RULES): the columns carry id, kind, scope and expiry, `definition` the rest
      await insertUnreadable('authz_rule', { id: 'r1', kind: 'cap', scope_type: P1.type, scope_id: P1.id, definition: JSON.stringify({ ladder: 'project', maxRole: 'editor', assignments: { scopeTypes: ['file'] } }), created_at: '2026-09-30 08:15:30' });
      const store = db.container.resolve(DbRuleStore);
      const [rule] = await store.forPath([P1], AT);

      expect(Number.isNaN(rule.expiresAt!.getTime())).to.equal(true);
      const listed = (await store.find({ scope: P1 })).items;
      expect(listed.map((r) => [r.id, Number.isNaN(r.expiresAt!.getTime())])).to.deep.equal([['r1', true]]);
    });

    it('turns a link with such an expiry into an unknown link, whose principal reaches nothing', async () => {
      await insertUnreadable('authz_link', { id: 'l1', token_hash: 'h1', scope_type: P1.type, scope_id: P1.id, created_at: '2026-09-30 08:15:30' });
      const { items } = await db.container.resolve(DbLinkStore).find({ scope: P1 });

      expect(items).to.have.length(1);
      expect(Number.isNaN(items[0].expiresAt!.getTime())).to.equal(true);
      expect(linkPrincipalOf(items[0], 'l1').ceiling?.resources).to.deep.equal([]);
    });

    it('counts a paged list without the flag column, and flags the rows of the page', async () => {
      const carol: PrincipalRef = { type: 'user', id: 'carol' };
      await insertUnreadable('authz_assignment', assignment('c1', carol));
      await db.driver.insert().into('authz_assignment').values({ ...assignment('c2', carol), role: 'viewer', expires_at: null });

      const page = await db.container.resolve(DbAssignmentStore).find({ subject: carol, at: AT }, { limit: 1, offset: 0 });

      expect(page.total).to.equal(2);
      expect(page.items).to.have.length(1);
      expect(Number.isNaN(page.items[0].expiresAt!.getTime())).to.equal(true);
    });

    it('keeps a narrowing rule and a deny through a set in force when their expiry is unreadable: the check and the list are refused, never widened', async () => {
      const P2: ResourceRef = { type: 'project', id: 'p2' };
      const P3: ResourceRef = { type: 'project', id: 'p3' };
      const F2: ResourceRef = { type: 'file', id: 'f2' };
      const F3: ResourceRef = { type: 'file', id: 'f3' };
      const T1: ResourceRef = { type: 'team', id: 't1' };
      const member: AssignmentSubject = { set: { role: 'team.member', scope: T1 } };
      const row = (id: string, subject: AssignmentSubject, role: string, scope: ResourceRef) => ({ id, ...subjectToColumns(subject), subject_key: subjectKeyOf(subject), role, ...scopeToColumns(scope), tags: '', source: 'db', created_at: '2026-09-30 08:15:30' });
      // dave edits P2 under a cap to viewer at P2; erin edits P3 and, through team t1, holds `blocked`, which denies file:edit everywhere
      await db.driver.insert().into('authz_assignment').values([
        { ...row('d1', { type: 'user', id: 'dave' }, 'editor', P2), expires_at: null },
        { ...row('e1', { type: 'user', id: 'erin' }, 'editor', P3), expires_at: null },
        { ...row('g1', { type: 'user', id: 'frank' }, 'editor', P3), expires_at: null },
        { ...row('s1', member, 'blocked', GLOBAL), expires_at: null },
      ]);
      await insertUnreadable('authz_rule', { id: 'cap-p2', kind: 'cap', scope_type: P2.type, scope_id: P2.id, definition: JSON.stringify({ ladder: 'project', maxRole: 'viewer' }), created_at: '2026-09-30 08:15:30' });
      await insertUnreadable('authz_assignment', row('e2', { type: 'user', id: 'erin' }, 'team.member', T1));

      const role = (name: string, grants: readonly string[], extra: Partial<RoleDef> = {}): RoleDef => ({ name, extends: [], assignable: true, source: 'test', ...extra, grants: grants.map((permission) => ({ permission })) });
      const roles = [role('viewer', ['file:read'], { ladder: 'project' }), role('editor', ['file:read', 'file:edit'], { ladder: 'project' }), role('team.member', [], { subjectSet: true }), role('blocked', ['file:edit'], { deny: true })];
      const ladders: LadderDef[] = [{ name: 'project', roles: ['viewer', 'editor'] }];
      const permissions = new PermissionRegistryImpl();
      permissions.register(['file:read', 'file:edit'].map((name) => ({ name, types: ['project', 'file'], list: true })), 'test');
      permissions.freeze();
      const model = new RbacModel({ roles: new MemoryRoleStore(roles, ladders), assignments: db.container.resolve(DbAssignmentStore), rules: db.container.resolve(DbRuleStore), log: { warn: () => undefined } });
      await model.init(fakeModelInitContext({ model: 'rbac', permissions }));
      const ctx = fakeEvaluationContext({ now: AT, scopeResolvers: [new FakeScopeResolver({ types: ['project', 'file', 'team'], nodes: [{ ref: P2 }, { ref: F2, parent: P2 }, { ref: P3 }, { ref: F3, parent: P3 }, { ref: T1 }] })] });
      const outcome = (who: string, resource: ResourceRef): Promise<unknown> =>
        Promise.resolve(model.evaluate({ principal: userPrincipal(who), permission: 'file:edit', resource }, ctx)).then(
          (vote) => vote.permitWhen,
          (err: unknown) => messageOf(err),
        );
      const listed = (who: string): Promise<unknown> =>
        model.listPlan({ principal: userPrincipal(who), permission: permissions.require('file:edit'), type: 'file', env: { now: AT } }, ctx).then(
          (plan) => plan.kind,
          (err: unknown) => messageOf(err),
        );

      expect(await outcome('dave', F2)).to.be.a('string').that.contains('expiresAt is not a valid date');
      expect(await outcome('erin', F3)).to.be.a('string').that.matches(/assignment 'e2' .*unreadable expiresAt/);
      expect(await outcome('frank', F3)).to.deep.equal(TRUE);
      expect(await listed('dave')).to.be.a('string').that.contains("rule 'cap-p2' (cap, source: db) can apply to file:edit");
    });
  });
}

describe('RBAC membership recompute: an assignment whose expiry no converter reads', () => {
  const roles: RoleIndex = {
    roles: new Map([
      ['team.member', { name: 'team.member', extends: [], grants: [], subjectSet: true, assignable: true, source: 'test' }],
      ['editor', { name: 'editor', extends: [], grants: [], assignable: true, source: 'test' }],
    ]),
    ladders: new Map(),
    ladderOf: () => undefined,
  };
  const row = (expiresAt: Date | null): Assignment => ({ id: 'm1', subject: subjectFromColumns('user', 'alice', ''), role: 'team.member', scope: { type: 'team', id: 't1' }, expiresAt, source: 'db' });

  it('refuses it instead of writing a membership that never expires, when its role makes a set member', () => {
    expect(() => membershipEdges(roles, [row(new Date(NaN))])).to.throw(AuthzConfigError, /assignment 'm1' has an unreadable expiresAt/);
    expect(membershipEdges(roles, [row(null)]).map((e) => e.expiresAt)).to.deep.equal([null]);
    // a role that makes no member gives no edge, so the recompute of its subject is not blocked by it (read-sx-5b M3)
    expect(membershipEdges(roles, [{ ...row(new Date(NaN)), id: 'e1', role: 'editor' }])).to.deep.equal([]);
  });
});
