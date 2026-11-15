import type { PlanRow } from '@spinajs/authz-orm/plan';
import { rlsContext } from '@spinajs/authz-orm';
import { Wrapper } from '@spinajs/orm';
import type { IWhereBuilder } from '@spinajs/orm';
import * as chai from 'chai';
import 'mocha';

import { AUTHZ_ASSIGNMENT_TABLE, RbacAssignmentTerm, rbacPlanArgs } from '../../src/index.js';
import type { RbacAssignmentPlanArgs } from '../../src/index.js';
import { bootDb, rawQuery } from '../support/db.js';
import type { TestDb } from '../support/db.js';

const expect = chai.expect;

const TASK = 'rls_task';
const ANCESTOR = 'rls_ancestor';
const HOUR = 3_600_000;

type Relations = Partial<Record<string, { column: string; typeColumn?: string }>>;

const args = (over: Partial<RbacAssignmentPlanArgs> = {}): RbacAssignmentPlanArgs => rbacPlanArgs({ subjects: [], roles: [{ role: 'editor' }], global: false, ...over });

function assignment(id: string, subjectKey: string, role: string, scopeType: string, scopeId: string, extra: { tags?: string; expiresAt?: Date } = {}): Record<string, unknown> {
  const [type, rest] = subjectKey.split(':');
  const [subjectId, subjectRole] = rest.split('#');
  return { id, subject_type: type, subject_id: subjectId, subject_role: subjectRole ?? '', subject_key: subjectKey, role, scope_type: scopeType, scope_id: scopeId, tags: extra.tags ?? '', expires_at: extra.expiresAt ?? null, created_at: new Date() };
}

/** rbac.assignment rendered for row level security agrees with the query-builder form on the same rows, with the subjects read from the session. */
describe('rbac.assignment as RLS SQL (postgres)', function () {
  this.timeout(60000);

  let db: TestDb;
  const term = new RbacAssignmentTerm();
  const relationsOf = (relations: Relations) => (name: string) => relations[name];

  before(async function () {
    db = await bootDb(this, 'postgres', 'rls-term');
    const d = db.driver;
    await d.schema().createTable(TASK, (table) => {
      table.int('id').primaryKey();
      table.string('owner_id', 64);
    });
    await d.schema().createTable(ANCESTOR, (table) => {
      table.string('resource_type', 64).notNull();
      table.string('resource_id', 64).notNull();
      table.string('ancestor_type', 64).notNull();
      table.string('ancestor_id', 64).notNull();
      table.int('depth').notNull();
    });
    await d
      .insert()
      .into(TASK)
      .values([1, 2, 3, 4, 5, 6].map((id) => ({ id, owner_id: id === 1 ? 'alice' : id === 5 ? 'bob' : null })));
    const up: [string, string, string][] = [
      ['1', 'project', 'p1'],
      ['1', 'org', 'o1'],
      ['2', 'project', 'p2'],
      ['2', 'org', 'o1'],
      ['3', 'project', 'p3'],
      ['5', 'project', 'p1'],
      ['5', 'org', 'o1'],
      ['6', 'project', 'p4'],
    ];
    await d
      .insert()
      .into(ANCESTOR)
      .values(up.map(([id, type, ancestor], i) => ({ resource_type: 'task', resource_id: id, ancestor_type: type, ancestor_id: ancestor, depth: i })));
    const now = Date.now();
    await d
      .insert()
      .into(AUTHZ_ASSIGNMENT_TABLE)
      .values([
        assignment('a1', 'user:alice', 'editor', 'project', 'p1'),
        assignment('a2', 'team:t1#member', 'editor', 'task', '3'),
        assignment('a3', 'user:alice', 'editor', 'task', '4', { expiresAt: new Date(now - HOUR) }),
        assignment('a4', 'user:alice', 'billing', 'project', 'p2', { tags: 'paid' }),
        assignment('a5', 'user:alice', 'blocked', 'org', 'o1'),
        assignment('a7', 'user:alice', 'member', 'project', 'p1'),
        assignment('a8', 'user:carol', 'viewer', '$global', ''),
        assignment('a9', 'user:dave', 'auditor', 'project', ''),
        assignment('a10', 'user:erin', 'billing', 'project', 'p4'),
        assignment('a11', 'user:erin', 'payer', '$global', '', { tags: 'paid' }),
      ]);
  });

  after(async () => {
    await db?.dispose();
  });

  async function rls(keys: string[], a: RbacAssignmentPlanArgs, relations: Relations = { owner: { column: 'owner_id' } }): Promise<number[]> {
    const ctx = rlsContext({ type: 'task', table: TASK, idColumn: 'id', relations: relationsOf(relations), ancestorTable: ANCESTOR });
    const rows = (await db.driver.transaction(async () => {
      await rawQuery(db.driver, "SELECT set_config('spina.subject_keys', ?, true)", [JSON.stringify(keys)]);
      await rawQuery(db.driver, `SELECT set_config('spina.principal', ?, true)`, [JSON.stringify(keys.filter((k) => !k.includes('#')).map((k) => ({ type: k.split(':')[0], id: k.split(':')[1] })))]);
      return rawQuery(db.driver, `SELECT id FROM "${TASK}" WHERE ${term.renderSql(a, ctx)}`) as Promise<{ id: unknown }[]>;
    })) as { id: unknown }[];
    return rows.map((r) => Number(r.id)).sort((x, y) => x - y);
  }

  async function builder(a: RbacAssignmentPlanArgs, relations: Relations = { owner: { column: 'owner_id' } }): Promise<number[]> {
    const row: PlanRow = { type: 'task', id: Wrapper.Text('id'), relation: relationsOf(relations), ancestorTable: ANCESTOR, now: () => db.driver.now(), from: (table, alias) => db.driver.select<unknown>().from(table, alias) };
    const rows = await db.driver
      .select()
      .select('id')
      .from(TASK)
      .where(function (this: IWhereBuilder<unknown>) {
        term.apply(a, this, row);
      })
      .asRaw<{ id: unknown }[]>();
    return rows.map((r) => Number(r.id)).sort((x, y) => x - y);
  }

  it('agrees with the query-builder form, the subjects read from spina.subject_keys', async () => {
    const keys = ['team:t1#member', 'user:alice'];
    for (const a of [args(), args({ roles: [{ role: 'editor', descendantsOnly: true }] }), args({ roles: [{ role: 'editor', scopeTypes: ['task'] }] }), args({ roles: [{ role: 'blocked' }], global: true }), args({ roles: [{ role: 'member', relation: 'owner' }] })]) {
      expect(await rls(keys, a)).to.deep.equal(await builder(rbacPlanArgs({ ...a, subjects: keys })));
    }
    expect(await rls(keys, args())).to.deep.equal([1, 3, 5]);
  });

  it('matches nothing without session keys (fail closed)', async () => {
    expect(await rls([], args({ roles: [{ role: 'viewer' }], global: true }))).to.deep.equal([]);
    expect(await rls(['user:carol'], args({ roles: [{ role: 'viewer' }], global: true }))).to.deep.equal([1, 2, 3, 4, 5, 6]);
  });

  it('counts an assignment at the bare type of an ancestor for every row under it, as checks do', async () => {
    expect(await rls(['user:dave'], args({ roles: [{ role: 'auditor' }] }))).to.deep.equal([1, 2, 3, 5, 6]);
  });

  it("reads a tag from the granting assignment or the principal's live tag set at $global", async () => {
    const billing = args({ roles: [{ role: 'billing', tag: 'paid' }] });
    expect(await rls(['user:alice'], billing)).to.deep.equal([2]);
    expect(await rls(['user:erin'], billing)).to.deep.equal([6]);
  });
});
