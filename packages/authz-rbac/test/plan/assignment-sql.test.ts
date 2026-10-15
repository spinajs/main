import { PlanTermSql } from '@spinajs/authz';
import type { SqlFragment, SqlRowContext } from '@spinajs/authz';
import { DI } from '@spinajs/di';
import { QueryContext } from '@spinajs/orm';
import * as chai from 'chai';
import 'mocha';

import { RbacAssignmentSql, parsePrincipalSubjectKey, parseRbacPlanArgs, rbacAssignmentSql, rbacPlanArgs, sqliteDateTime } from '../../src/index.js';
import type { RbacAssignmentPlanArgs } from '../../src/index.js';
import { bootDb, rawQuery } from '../support/db.js';
import type { TestDb } from '../support/db.js';

const expect = chai.expect;

const NOW = new Date('2026-10-14T12:00:00.000Z');
const OWNER = { column: 'owner_id' };
const row = (dialect: SqlRowContext['dialect'] = 'postgres', relation: SqlRowContext['relation'] = (name) => (name === 'owner' ? OWNER : undefined)): SqlRowContext => ({ type: 'task', rowId: 'CAST(t.id AS TEXT)', rowColumn: (c) => `t.${c}`, ancestorTable: 'authz_resource_ancestor', relation, now: NOW, dialect });
const args = (over: Partial<RbacAssignmentPlanArgs> = {}): RbacAssignmentPlanArgs => rbacPlanArgs({ subjects: ['user:alice'], membership: false, memberKeys: [], roles: [{ role: 'editor' }], global: false, ...over });

const LIVE = (a: string) => `(${a}.expires_at IS NULL OR ${a}.expires_at > ?)`;
const DIRECT = `EXISTS (SELECT 1 FROM authz_assignment authz_s WHERE authz_s.scope_type = ? AND authz_s.scope_id = CAST(t.id AS TEXT) AND authz_s.subject_key IN (?) AND ${LIVE('authz_s')} AND (authz_s.role IN (?)))`;
const ABOVE = `EXISTS (SELECT 1 FROM authz_resource_ancestor authz_a JOIN authz_assignment authz_s ON authz_s.scope_type = authz_a.ancestor_type AND authz_s.scope_id = authz_a.ancestor_id WHERE authz_a.resource_type = ? AND authz_a.resource_id = CAST(t.id AS TEXT) AND authz_s.subject_key IN (?) AND ${LIVE('authz_s')} AND (authz_s.role IN (?)))`;

describe('authz-rbac plan SQL (design §6.2)', () => {
  describe('args', () => {
    it('canonical: sorted, deduplicated, frozen', () => {
      const a = rbacPlanArgs({ subjects: ['user:b', 'user:a', 'user:b'], membership: false, memberKeys: [], roles: [{ role: 'z' }, { role: 'a', scopeTypes: ['project', 'org'] }, { role: 'z' }], global: false });
      expect(a).to.deep.equal({ subjects: ['user:a', 'user:b'], membership: false, memberKeys: [], roles: [{ role: 'a', scopeTypes: ['org', 'project'] }, { role: 'z' }], global: false });
      expect(Object.isFrozen(a.roles)).to.equal(true);
    });

    it('parse refuses unknown keys and wrong types', () => {
      expect(() => parseRbacPlanArgs({ ...args(), extra: 1 })).to.throw('rbac.assignment: unknown args key(s) extra');
      expect(() => parseRbacPlanArgs({ ...args(), roles: [{ role: 'x', when: 1 }] })).to.throw('rbac.assignment: roles[0] has unknown key(s) when');
      expect(() => parseRbacPlanArgs({ ...args(), membership: 'yes' })).to.throw('rbac.assignment: membership must be a boolean');
      expect(parseRbacPlanArgs(JSON.parse(JSON.stringify(args())))).to.deep.equal(args());
    });
  });

  describe('rendering', () => {
    it('permit: the direct and the ancestor branch', () => {
      const out = rbacAssignmentSql(args(), row());
      expect(out.sql).to.equal(`(${DIRECT} OR ${ABOVE})`);
      expect(out.bindings).to.deep.equal(['task', 'user:alice', NOW, 'editor', 'task', 'user:alice', NOW, 'editor']);
    });

    it('descendantsOnly leaves the direct branch out; qualifiers group per role', () => {
      const out = rbacAssignmentSql(args({ roles: [{ role: 'lead', descendantsOnly: true }, { role: 'pm', scopeTypes: ['project'] }, { role: 'paid', tag: 'gold' }] }), row('sqlite'));
      expect(out.sql).to.contain("authz_s.scope_type IN (?)");
      expect(out.sql).to.contain('instr(authz_s.tags, ?) > 0');
      expect(out.bindings).to.include(',gold,');
      expect(out.sql.split('EXISTS (SELECT 1 FROM authz_assignment authz_s WHERE')[1]).to.not.contain("'lead'");
    });

    it('dialects differ only in the tag test and the now binding', () => {
      const tagged = (dialect: SqlRowContext['dialect']) => rbacAssignmentSql(args({ roles: [{ role: 'paid', tag: 'gold' }] }), row(dialect)).sql;
      expect(tagged('postgres')).to.contain('strpos(authz_s.tags, ?) > 0');
      expect(tagged('mysql')).to.contain('LOCATE(?, authz_s.tags) > 0');
      expect(tagged('mssql')).to.contain('CHARINDEX(?, authz_s.tags) > 0');
      expect(rbacAssignmentSql(args(), row('sqlite')).bindings[2]).to.equal(sqliteDateTime(NOW));
    });

    it('deny: the single EXISTS shape of design §6.2 with the membership sub-query', () => {
      const out = rbacAssignmentSql(args({ subjects: ['user:alice'], membership: true, memberKeys: ['user:alice'], roles: [{ role: 'blocked' }], global: true }), row('postgres'));
      expect(out.sql).to.equal(
        'EXISTS (SELECT 1 FROM authz_assignment authz_d WHERE (authz_d.subject_key IN (?) OR authz_d.subject_key IN (SELECT authz_m.set_key FROM authz_subject_membership authz_m WHERE authz_m.member_key IN (?) AND (authz_m.expires_at IS NULL OR authz_m.expires_at > ?))) AND authz_d.role IN (?) AND (authz_d.expires_at IS NULL OR authz_d.expires_at > ?) AND ((authz_d.scope_type = ? AND authz_d.scope_id = CAST(t.id AS TEXT)) OR EXISTS (SELECT 1 FROM authz_resource_ancestor authz_a WHERE authz_a.resource_type = ? AND authz_a.resource_id = CAST(t.id AS TEXT) AND authz_a.ancestor_type = authz_d.scope_type AND authz_a.ancestor_id = authz_d.scope_id) OR authz_d.scope_type = ?))',
      );
      expect(out.bindings).to.deep.equal(['user:alice', 'user:alice', NOW, 'blocked', NOW, 'task', 'task', '$global']);
    });

    it('no role or no subject is FALSE', () => {
      expect(rbacAssignmentSql(args({ roles: [] }), row()).sql).to.equal('(1 = 0)');
      expect(rbacAssignmentSql(args({ subjects: [] }), row()).sql).to.equal('(1 = 0)');
    });

    it('a relation ANDs the role with the relation column of the principals among the subjects', () => {
      const owned = args({ subjects: ['user:*', 'user:alice', 'team:t1#member'], roles: [{ role: 'member', relation: 'owner' }] });
      const plain = rbacAssignmentSql(owned, row());
      expect(plain.sql).to.contain('(authz_s.role = ? AND t.owner_id IN (?))');
      expect(plain.bindings).to.include.members(['member', 'alice']);
      const typed = rbacAssignmentSql(owned, row('postgres', () => ({ column: 'owner_id', typeColumn: 'owner_type' })));
      expect(typed.sql).to.contain('(authz_s.role = ? AND ((t.owner_type = ? AND t.owner_id = ?)))');
      expect(rbacAssignmentSql(owned, row('postgres', () => undefined)).sql).to.equal('(1 = 0)');
      expect(parsePrincipalSubjectKey('user:%2A')).to.deep.equal({ type: 'user', id: '*' });
      expect(parsePrincipalSubjectKey('user:*')).to.equal(undefined);
      expect(parsePrincipalSubjectKey('team:t1#member')).to.equal(undefined);
    });

    it('is registered as PlanTermSql', async () => {
      const ops = ((await DI.resolve(Array.ofType(PlanTermSql))) as PlanTermSql[]).map((c) => c.op);
      expect(ops).to.include('rbac.assignment');
      expect(new RbacAssignmentSql().op).to.equal('rbac.assignment');
    });
  });

  describe('on SQLite', function () {
    this.timeout(30000);
    let db: TestDb;
    const run = (sql: string, bindings: readonly unknown[] = []) => rawQuery(db.driver, sql, [...bindings], QueryContext.Schema);
    const ids = async (where: SqlFragment): Promise<number[]> => ((await rawQuery(db.driver, `SELECT t.id FROM task t WHERE ${where.sql} ORDER BY t.id`, [...where.bindings])) as { id: number }[]).map((r) => r.id);
    const past = sqliteDateTime(new Date(NOW.getTime() - 3_600_000));
    const sqlite = row('sqlite');
    const permit = (over: Partial<RbacAssignmentPlanArgs>) => rbacAssignmentSql(args(over), sqlite);

    before(async function () {
      db = await bootDb(this, 'sqlite', 'l8-plan-sql', { migrate: false });
      await run('CREATE TABLE task (id INTEGER PRIMARY KEY, title TEXT, owner_id TEXT)');
      await run("CREATE TABLE authz_assignment (id TEXT PRIMARY KEY, subject_key TEXT NOT NULL, role TEXT NOT NULL, scope_type TEXT NOT NULL, scope_id TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '', expires_at TEXT)");
      await run('CREATE TABLE authz_subject_membership (member_key TEXT NOT NULL, set_key TEXT NOT NULL, depth INTEGER NOT NULL, expires_at TEXT, PRIMARY KEY (member_key, set_key))');
      await run('CREATE TABLE authz_resource_ancestor (resource_type TEXT NOT NULL, resource_id TEXT NOT NULL, ancestor_type TEXT NOT NULL, ancestor_id TEXT NOT NULL, depth INTEGER NOT NULL, PRIMARY KEY (resource_type, resource_id, ancestor_type, ancestor_id))');
      for (const [id, owner] of [[1, 'alice'], [2, null], [3, null], [4, null], [5, 'bob']] as const) await run('INSERT INTO task (id, title, owner_id) VALUES (?, ?, ?)', [id, `t${id}`, owner]);
      const up = [
        ['1', 'project', 'p1', 1],
        ['1', 'org', 'o1', 2],
        ['2', 'project', 'p2', 1],
        ['2', 'org', 'o1', 2],
        ['3', 'project', 'p3', 1],
        ['5', 'project', 'p1', 1],
        ['5', 'org', 'o1', 2],
      ];
      for (const [id, type, anc, depth] of up) await run('INSERT INTO authz_resource_ancestor VALUES (?, ?, ?, ?, ?)', ['task', id, type, anc, depth]);
      const rows = [
        ['a1', 'user:alice', 'editor', 'project', 'p1', '', null],
        ['a2', 'team:t1#member', 'editor', 'task', '3', '', null],
        ['a3', 'user:alice', 'editor', 'task', '4', '', past],
        ['a4', 'user:alice', 'billing', 'project', 'p2', ',paid,', null],
        ['a5', 'user:alice', 'blocked', 'org', 'o1', '', null],
        ['a6', 'user:bob', 'editor', 'project', 'p3', '', null],
        ['a7', 'user:alice', 'member', 'project', 'p1', '', null],
      ];
      for (const r of rows) await run('INSERT INTO authz_assignment VALUES (?, ?, ?, ?, ?, ?, ?)', r);
      await run('INSERT INTO authz_subject_membership VALUES (?, ?, ?, ?)', ['user:alice', 'team:t1#member', 1, null]);
    });

    after(async () => {
      await db?.dispose();
    });

    it('explicit subjects: direct and ancestor grants, expiry honoured', async () => {
      expect(await ids(permit({ subjects: ['team:t1#member', 'user:alice'] }))).to.deep.equal([1, 3, 5]);
    });

    it('the membership sub-query finds the same sets', async () => {
      expect(await ids(permit({ subjects: ['user:alice'], membership: true, memberKeys: ['user:alice'] }))).to.deep.equal([1, 3, 5]);
    });

    it('descendantsOnly, scopeTypes and tag', async () => {
      expect(await ids(permit({ subjects: ['team:t1#member', 'user:alice'], roles: [{ role: 'editor', descendantsOnly: true }] }))).to.deep.equal([1, 5]);
      expect(await ids(permit({ subjects: ['team:t1#member', 'user:alice'], roles: [{ role: 'editor', scopeTypes: ['task'] }] }))).to.deep.equal([3]);
      expect(await ids(permit({ roles: [{ role: 'billing', tag: 'paid' }] }))).to.deep.equal([2]);
      expect(await ids(permit({ roles: [{ role: 'billing', tag: 'other' }] }))).to.deep.equal([]);
    });

    it('a relation entry keeps the rows under the assignment that the principal owns', async () => {
      expect(await ids(permit({ roles: [{ role: 'member', relation: 'owner' }] }))).to.deep.equal([1]);
    });

    it('a deny term removes the rows under its scope', async () => {
      const allowed = permit({ subjects: ['team:t1#member', 'user:alice'] });
      const denied = rbacAssignmentSql(args({ roles: [{ role: 'blocked' }], global: true }), sqlite);
      expect(await ids(denied)).to.deep.equal([1, 2, 5]);
      expect(await ids({ sql: `${allowed.sql} AND NOT ${denied.sql}`, bindings: [...allowed.bindings, ...denied.bindings] })).to.deep.equal([3]);
    });

    it('an expired membership drops its sets', async () => {
      await run('UPDATE authz_subject_membership SET expires_at = ?', [past]);
      try {
        expect(await ids(permit({ subjects: ['user:alice'], membership: true, memberKeys: ['user:alice'] }))).to.deep.equal([1, 5]);
      } finally {
        await run('UPDATE authz_subject_membership SET expires_at = NULL');
      }
    });
  });
});
