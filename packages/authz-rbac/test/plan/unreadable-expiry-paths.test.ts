import * as chai from 'chai';
import 'mocha';

import { FALSE, PermissionRegistryImpl, TRUE } from '@spinajs/authz';
import type { ModelListPlan, PlanTerm, ResourceRef } from '@spinajs/authz';
import { rlsContext } from '@spinajs/authz-orm';
import type { PlanRow } from '@spinajs/authz-orm/plan';
import { FakeScopeResolver, fakeEvaluationContext, fakeModelInitContext, userPrincipal } from '@spinajs/authz-testing';
import { QueryContext, RawQuery, Wrapper } from '@spinajs/orm';
import type { IWhereBuilder } from '@spinajs/orm';

import { AssignmentRecord, DbAssignmentStore, DbMembershipStore, DbRuleStore, MemoryRoleStore, RbacAssignmentTerm, RbacModel, RbacRlsSubjectKeys, expiryOf, rbacRlsPlan, scopeToColumns, subjectKeyOf, subjectToColumns, withExpirySet } from '../../src/index.js';
import type { AssignmentSubject, LadderDef, RoleDef } from '../../src/index.js';
import { readableExpiry, whereLive } from '../../src/stores/queries.js';
import { bootDb, rawQuery } from '../support/db.js';
import type { TestDb } from '../support/db.js';

const expect = chai.expect;

type Kind = 'sqlite' | 'postgres' | 'mysql';
/** Unreadable values: `low` sorts before now in the database's order, `high` after it; a SQLite column keeps any text. */
const DIALECTS: readonly { kind: Kind; low: readonly string[]; high: readonly string[] }[] = [
  { kind: 'sqlite', low: ["''", "'0garbage'", "'2020-01-01  00:00:00'", "'2020-01-01T'"], high: ["'not a date'", "'2099-01-01T00:00:00 Z'"] },
  { kind: 'postgres', low: ["'-infinity'"], high: ["'infinity'", "'294276-12-31 00:00:00+00'"] },
  { kind: 'mysql', low: ["'0000-00-00 00:00:00'", "'2026-00-10 00:00:00'"], high: ["'2099-12-00 00:00:00'"] },
];
const EXPIRED = 'a readable instant a day ago';
const NONE = 'null';

const FILE = 'sx19b_file';
const ANCESTOR = 'sx19b_ancestor';
const O1: ResourceRef = { type: 'org', id: 'o1' };
const P1: ResourceRef = { type: 'project', id: 'p1' };
const F1: ResourceRef = { type: 'file', id: 'f1' };
const user: AssignmentSubject = { type: 'user', id: 'u' };
const team = (id: string): AssignmentSubject => ({ set: { role: 'team.member', scope: { type: 'team', id } } });

/** What the row whose expiry is under test does: it grants editor at P1, or it restricts that grant. */
type RowKind = 'deny assignment' | 'deny role of a set' | 'narrowing rule' | 'assignment making a set member' | 'membership row' | 'grant';
const ROW_KINDS: readonly RowKind[] = ['deny assignment', 'deny role of a set', 'narrowing rule', 'assignment making a set member', 'membership row', 'grant'];

/** Each path's answer: `refused` (model_error or a refused read), whether u may edit f1, or the files a filter shows. */
interface Paths {
  check: unknown;
  checkAfterReload: unknown;
  list: unknown;
  listAfterReload: unknown;
  /** The list plan made while the row had no expiry, run in SQL after the row took the value. */
  stalePlan?: unknown;
  rls?: unknown;
}

const roles: RoleDef[] = [
  { name: 'viewer', extends: [], assignable: true, source: 'test', ladder: 'project', grants: [{ permission: 'file:read' }] },
  { name: 'editor', extends: [], assignable: true, source: 'test', ladder: 'project', grants: [{ permission: 'file:read' }, { permission: 'file:edit' }] },
  { name: 'team.member', extends: [], assignable: true, source: 'test', subjectSet: true, grants: [] },
  { name: 'blocked', extends: [], assignable: true, source: 'test', deny: true, grants: [{ permission: 'file:edit' }] },
];
const ladders: LadderDef[] = [{ name: 'project', roles: ['viewer', 'editor'] }];

for (const { kind, low, high } of DIALECTS) {
  describe(`an unreadable expiry on every path of a restriction or a grant (${kind})`, function () {
    this.timeout(120000);

    let db: TestDb<Kind>;
    const term = new RbacAssignmentTerm();

    const setExpiry = async (table: string, id: string, value: string): Promise<void> => {
      const column = table === 'authz_subject_membership' ? 'member_key' : 'id';
      const sql = `UPDATE ${table} SET expires_at = ${value} WHERE ${column} = ?`;
      if (kind !== 'mysql') return void (await rawQuery(db.driver, sql, [id], QueryContext.Update));
      // MySQL's strict mode refuses a zero day; a transaction keeps the relaxed session mode on one connection
      await db.driver.transaction(async () => {
        await rawQuery(db.driver, "SET SESSION sql_mode = ''", [], QueryContext.Update);
        try {
          await rawQuery(db.driver, sql, [id], QueryContext.Update);
        } finally {
          await rawQuery(db.driver, 'SET SESSION sql_mode = DEFAULT', [], QueryContext.Update);
        }
      });
    };

    const assignment = (id: string, subject: AssignmentSubject, role: string, scope: ResourceRef) => ({ id, ...subjectToColumns(subject), subject_key: subjectKeyOf(subject), role, ...scopeToColumns(scope), tags: '', source: 'db', created_at: new Date(), expires_at: null });

    /** The rows of a row kind; the first entry is the one whose expiry is under test. */
    const fixture = (rowKind: RowKind): { table: string; id: string; rows: Record<string, Record<string, unknown>[]> } => {
      const editor = assignment('e', user, 'editor', P1);
      switch (rowKind) {
        case 'deny assignment':
          return { table: 'authz_assignment', id: 't', rows: { authz_assignment: [assignment('t', user, 'blocked', O1), editor] } };
        case 'deny role of a set':
          return { table: 'authz_assignment', id: 't', rows: { authz_assignment: [assignment('t', team('t1'), 'blocked', O1), assignment('m', user, 'team.member', { type: 'team', id: 't1' }), editor] } };
        case 'narrowing rule':
          return { table: 'authz_rule', id: 't', rows: { authz_rule: [{ id: 't', kind: 'cap', ...scopeToColumns(P1), definition: JSON.stringify({ ladder: 'project', maxRole: 'viewer' }), created_at: new Date(), expires_at: null }], authz_assignment: [editor] } };
        case 'assignment making a set member':
          return { table: 'authz_assignment', id: 't', rows: { authz_assignment: [assignment('t', user, 'team.member', { type: 'team', id: 't1' }), assignment('s', team('t1'), 'blocked', O1), editor] } };
        case 'membership row':
          return { table: 'authz_subject_membership', id: subjectKeyOf(user), rows: { authz_subject_membership: [{ member_key: subjectKeyOf(user), set_key: subjectKeyOf(team('t9')), depth: 1, expires_at: null }], authz_assignment: [assignment('s', team('t9'), 'blocked', O1), editor] } };
        case 'grant':
          return { table: 'authz_assignment', id: 'e', rows: { authz_assignment: [editor] } };
      }
    };

    const permissions = new PermissionRegistryImpl();
    permissions.register(['file:read', 'file:edit'].map((name) => ({ name, types: ['project', 'file'], list: true })), 'test');
    permissions.freeze();
    const edit = permissions.require('file:edit');

    const newModel = async (): Promise<RbacModel> => {
      const model = new RbacModel({ roles: new MemoryRoleStore(roles, ladders), assignments: db.container.resolve(DbAssignmentStore), rules: db.container.resolve(DbRuleStore), membership: db.container.resolve(DbMembershipStore), log: { warn: () => undefined } });
      await model.init(fakeModelInitContext({ model: 'rbac', permissions }));
      return model;
    };
    const context = () => fakeEvaluationContext({ now: new Date(), scopeResolvers: [new FakeScopeResolver({ types: ['org', 'project', 'file', 'team'], nodes: [{ ref: O1 }, { ref: P1, parent: O1 }, { ref: F1, parent: P1 }, { ref: { type: 'team', id: 't1' } }, { ref: { type: 'team', id: 't9' } }] })] });
    const refusedOr = <T>(run: () => Promise<T>): Promise<T | 'refused'> => run().catch(() => 'refused' as const);

    const check = (model: RbacModel) =>
      refusedOr(async () => {
        const vote = await model.evaluate({ principal: userPrincipal('u'), permission: 'file:edit', resource: F1 }, context());
        if (vote.error !== undefined) return 'refused';
        return vote.permitWhen === TRUE && vote.denyWhen === FALSE ? 'may edit' : 'may not edit';
      });

    const row: PlanRow = { type: 'file', id: Wrapper.Text('id'), relation: () => undefined, ancestorTable: ANCESTOR, now: () => db.driver.now(), from: (table, alias) => db.driver.select<unknown>().from(table, alias) };
    const each = (terms: readonly PlanTerm[], where: IWhereBuilder<unknown>) => {
      for (const t of terms) {
        where.orWhere(function () {
          term.apply(t.args, this, row);
        });
      }
    };
    /** The files the list filter shows, as authz-orm joins a plan: some permit term and no deny term. */
    const shown = async (plan: ModelListPlan): Promise<string[]> => {
      if (plan.kind === 'abstain' || plan.kind === 'deny-all') return [];
      const query = db.driver.select().select('id').from(FILE);
      if (plan.kind === 'terms')
        query.where(function () {
          each(plan.permit, this);
        });
      const deny = plan.deny ?? [];
      if (deny.length > 0)
        query.whereNot(function () {
          each(deny, this);
        });
      if (kind !== 'mysql') return (await query.asRaw<{ id: string }[]>()).map((r) => r.id);
      // CAST(id AS CHAR) takes the connection's collation, which MySQL refuses to compare with the tables' (the SX-26 family's issue)
      return db.driver.transaction(async () => {
        // DEFAULT would be the server's collation, not the handshake's the pooled connection had
        await rawQuery(db.driver, 'SET @sx19b_collation = @@collation_connection', [], QueryContext.Update);
        await rawQuery(db.driver, "SET SESSION collation_connection = (SELECT TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'authz_assignment')", [], QueryContext.Update);
        try {
          return (await query.asRaw<{ id: string }[]>()).map((r) => r.id);
        } finally {
          await rawQuery(db.driver, 'SET SESSION collation_connection = @sx19b_collation', [], QueryContext.Update);
        }
      });
    };
    const list = async (model: RbacModel) => {
      const plan = await refusedOr(() => model.listPlan({ principal: userPrincipal('u'), permission: edit, type: 'file' }, context()));
      return plan === 'refused' ? plan : shown(plan);
    };

    /** Row level security as `authz:rls` renders it: the session's subject keys, every permit term ORed, AND NOT the deny terms. */
    const rls = async (model: RbacModel) => {
      const keys = await refusedOr(() => new RbacRlsSubjectKeys().keys(model, userPrincipal('u')));
      if (keys === 'refused') return keys;
      const plan = rbacRlsPlan(model, edit, 'file');
      if (plan.kind !== 'terms') throw new Error(`unexpected RLS plan ${plan.kind}`);
      const ctx = rlsContext({ type: 'file', table: FILE, idColumn: 'id', relations: () => undefined, ancestorTable: ANCESTOR });
      const sql = (terms: readonly PlanTerm[]) => (terms.length === 0 ? 'FALSE' : terms.map((t) => `(${term.renderSql(t.args, ctx)})`).join(' OR '));
      const rows = await db.driver.transaction(async () => {
        await rawQuery(db.driver, "SELECT set_config('spina.subject_keys', ?, true)", [JSON.stringify(keys)]);
        return db.driver.select().select('id').from(FILE).where(RawQuery.create(`(${sql(plan.permit)}) AND NOT (${sql(plan.deny ?? [])})`)).asRaw<{ id: string }[]>();
      });
      return rows.map((r) => r.id);
    };

    async function pathsOf(rowKind: RowKind, value: string): Promise<Paths> {
      const { table, id, rows } = fixture(rowKind);
      for (const t of ['authz_assignment', 'authz_rule', 'authz_subject_membership']) await db.driver.del().from(t);
      for (const [t, values] of Object.entries(rows)) await db.driver.insert().into(t).values(values);
      const stale = rowKind === 'deny assignment' || rowKind === 'deny role of a set' || rowKind === 'grant' ? await (await newModel()).listPlan({ principal: userPrincipal('u'), permission: edit, type: 'file' }, context()) : undefined;
      if (value === EXPIRED) await db.driver.update().in(table).update({ expires_at: new Date(Date.now() - 86_400_000) }).where(table === 'authz_subject_membership' ? 'member_key' : 'id', id);
      else if (value !== NONE) await setExpiry(table, id, value);

      const model = await newModel();
      const out: Paths = { check: await check(model), checkAfterReload: undefined, list: await list(model), listAfterReload: undefined };
      model.invalidate(['*']);
      out.checkAfterReload = await check(model);
      out.listAfterReload = await list(model);
      if (stale) out.stalePlan = await shown(stale);
      if (kind === 'postgres' && rowKind !== 'narrowing rule') out.rls = await rls(model);
      return out;
    }

    /** What each path must answer (Global Constraints: a grant's unreadable expiry is expired; a restriction's is kept in force or refused). */
    function expected(rowKind: RowKind, value: string): Paths {
      const grant = rowKind === 'grant';
      const unreadable = value !== EXPIRED && value !== NONE;
      const editable = grant ? value === NONE : value === EXPIRED;
      const decided = unreadable ? 'refused' : editable ? 'may edit' : 'may not edit';
      // a rule that can match file:edit refuses its lists while it is live (refuseListRules)
      const listed = unreadable || (rowKind === 'narrowing rule' && value === NONE) ? 'refused' : editable ? ['f1'] : [];
      const out: Paths = { check: decided, checkAfterReload: decided, list: listed, listAfterReload: listed };
      if (rowKind === 'deny assignment' || rowKind === 'deny role of a set' || rowKind === 'grant') out.stalePlan = editable ? ['f1'] : [];
      // RLS renders no stored rule; the session keys refuse a membership they cannot read
      if (kind === 'postgres' && rowKind !== 'narrowing rule') out.rls = unreadable && (rowKind === 'assignment making a set member' || rowKind === 'membership row') ? 'refused' : editable ? ['f1'] : [];
      return out;
    }

    before(async function () {
      db = await bootDb(this, kind, `sx19b_${kind}`);
      await db.driver.schema().createTable(FILE, (t) => {
        t.string('id', 64).primaryKey();
      });
      await db.driver.schema().createTable(ANCESTOR, (t) => {
        t.string('resource_type', 64).notNull();
        t.string('resource_id', 64).notNull();
        t.string('ancestor_type', 64).notNull();
        t.string('ancestor_id', 64).notNull();
        t.int('depth').notNull();
      });
      await db.driver.insert().into(FILE).values([{ id: 'f1' }, { id: 'f2' }]);
      await db.driver.insert().into(ANCESTOR).values([
        { resource_type: 'file', resource_id: 'f1', ancestor_type: 'project', ancestor_id: 'p1', depth: 1 },
        { resource_type: 'file', resource_id: 'f1', ancestor_type: 'org', ancestor_id: 'o1', depth: 2 },
      ]);
    });

    after(async () => {
      await db?.dispose();
    });

    for (const rowKind of ROW_KINDS) {
      for (const value of [...low, ...high, EXPIRED, NONE]) {
        it(`${rowKind}, expires_at ${value}`, async () => {
          expect(await pathsOf(rowKind, value)).to.deep.equal(expected(rowKind, value));
        });
      }
    }

    it('classifies every value alike in SQL and in expiryOf, and the stores filter keeps each value the model refuses', async () => {
      // SQLite values the converter reads as epoch seconds, an ISO basic date or a bare year, which SQL calls unreadable: a list counts no grant and keeps every deny holding one
      const overListed = kind === 'sqlite' ? ["'1798761600'", '1798761600', "'20261019'", "'2026'"] : [];
      const spellings = kind === 'sqlite' ? ["'2027-01-01T00:00:00.000Z'", "'2027-01-01 00:00:00'", "'2027-01-01T00:00:00Z '", "'2027-01-01  00:00:00'", "'2027-01-01T24:30:00Z'", "'2027-01-01T00:00:00 +02:00'"] : ["'2027-01-01 00:00:00'"];
      const values = [...low, ...high, EXPIRED, NONE, ...spellings, ...overListed];
      const at = new Date();
      await db.driver.del().from('authz_assignment');
      await db.driver.insert().into('authz_assignment').values(values.map((_, i) => assignment(`v${i}`, { type: 'user', id: `v${i}` }, 'editor', P1)));
      for (const [i, value] of values.entries()) {
        if (value === EXPIRED) await db.driver.update().in('authz_assignment').update({ expires_at: new Date(at.getTime() - 86_400_000) }).where('id', `v${i}`);
        else if (value !== NONE) await setExpiry('authz_assignment', `v${i}`, value);
      }
      const classOf = async (id: string): Promise<{ sql: string; js: string; kept: boolean }> => {
        const one = () => db.driver.select().select('id').from('authz_assignment').where('id', id);
        const readable = readableExpiry(one(), 'expires_at');
        const sqlNull = (await one().whereNull('expires_at').asRaw<unknown[]>()).length === 1;
        const sqlReadable = readable !== undefined && (await one().where(readable).asRaw<unknown[]>()).length === 1;
        const live = one();
        whereLive(live, at);
        const [record] = await withExpirySet(AssignmentRecord.query().where('id', id));
        const js = expiryOf(record);
        return { sql: sqlNull ? 'null' : sqlReadable ? 'instant' : 'unreadable', js: js === null ? 'null' : Number.isNaN(js.getTime()) ? 'unreadable' : 'instant', kept: (await live.asRaw<unknown[]>()).length === 1 };
      };
      const table = await Promise.all(values.map(async (value, i) => ({ value, ...(await classOf(`v${i}`)) })));
      expect(table.map(({ value, sql }) => [value, sql])).to.deep.equal(table.map(({ value, js }) => [value, overListed.includes(value) ? 'unreadable' : js]));
      expect(table.filter((r) => overListed.includes(r.value)).map((r) => r.js)).to.deep.equal(overListed.map(() => 'instant'));
      expect(table.filter((r) => r.js !== 'instant' && !r.kept).map((r) => r.value)).to.deep.equal([]);
    });
  });
}
