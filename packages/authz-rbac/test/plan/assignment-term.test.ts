import type { PlanRow } from '@spinajs/authz-orm/plan';
import { Wrapper } from '@spinajs/orm';
import type { ICompilerOutput, IWhereBuilder } from '@spinajs/orm';
import * as chai from 'chai';
import 'mocha';

import { AUTHZ_ASSIGNMENT_TABLE, RbacAssignmentTerm, parseRbacPlanArgs, rbacPlanArgs } from '../../src/index.js';
import type { RbacAssignmentPlanArgs } from '../../src/index.js';
import { DB_KINDS, bootDb } from '../support/db.js';
import type { TestDb } from '../support/db.js';

const expect = chai.expect;

const TASK = 'plan_task';
const ANCESTOR = 'plan_ancestor';
const HOUR = 3_600_000;
const SUBJECT_KEY = /^([^:]+):([^#]+)(?:#(.+))?$/;

type Relations = Partial<Record<string, { column: string; typeColumn?: string }>>;

const args = (over: Partial<RbacAssignmentPlanArgs> = {}): RbacAssignmentPlanArgs => rbacPlanArgs({ subjects: ['user:alice'], roles: [{ role: 'editor' }], global: false, ...over });

function assignment(id: string, subjectKey: string, role: string, scopeType: string, scopeId: string, extra: { tags?: string; expiresAt?: Date } = {}): Record<string, unknown> {
  const [, type, subjectId, subjectRole] = SUBJECT_KEY.exec(subjectKey)!;
  return { id, subject_type: type, subject_id: subjectId, subject_role: subjectRole ?? '', subject_key: subjectKey, role, scope_type: scopeType, scope_id: scopeId, tags: extra.tags ?? '', expires_at: extra.expiresAt ?? null, created_at: new Date() };
}

for (const kind of DB_KINDS) {
  describe(`rbac.assignment on the query builders (${kind})`, function () {
    this.timeout(60000);

    let db: TestDb;
    const term = new RbacAssignmentTerm();

    const row = (relations: Relations = { owner: { column: 'owner_id' } }): PlanRow => ({
      type: 'task',
      id: Wrapper.Text('id'),
      relation: (name) => relations[name],
      ancestorTable: ANCESTOR,
      now: () => db.driver.now(),
      from: (table, alias) => db.driver.select<unknown>().from(table, alias),
    });

    const filtered = (apply: (where: IWhereBuilder<unknown>) => void) =>
      db.driver
        .select()
        .select('id')
        .from(TASK)
        .where(function () {
          apply(this);
        });

    async function ids(apply: (where: IWhereBuilder<unknown>) => void): Promise<number[]> {
      const rows = (await filtered(apply).asRaw()) as { id: unknown }[];
      return rows.map((r) => Number(r.id)).sort((a, b) => a - b);
    }

    const permit = (over: Partial<RbacAssignmentPlanArgs>, relations?: Relations) => ids((where) => term.apply(args(over), where, row(relations)));

    before(async function () {
      db = await bootDb(this, kind, 'plan-term');
      const d = db.driver;
      await d.schema().createTable(TASK, (table) => {
        table.int('id').primaryKey();
        table.string('owner_id', 64);
        table.string('owner_type', 32);
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
        .values([
          { id: 1, owner_id: 'alice', owner_type: 'user' },
          { id: 2, owner_id: null, owner_type: null },
          { id: 3, owner_id: null, owner_type: null },
          { id: 4, owner_id: null, owner_type: null },
          { id: 5, owner_id: 'bob', owner_type: 'user' },
        ]);
      const up: [string, string, string, number][] = [
        ['1', 'project', 'p1', 1],
        ['1', 'org', 'o1', 2],
        ['2', 'project', 'p2', 1],
        ['2', 'org', 'o1', 2],
        ['3', 'project', 'p3', 1],
        ['5', 'project', 'p1', 1],
        ['5', 'org', 'o1', 2],
      ];
      await d
        .insert()
        .into(ANCESTOR)
        .values(up.map(([id, type, ancestor, depth]) => ({ resource_type: 'task', resource_id: id, ancestor_type: type, ancestor_id: ancestor, depth })));
      // Expiry is judged by the database's clock, so the fixtures sit an hour on either side of it.
      const now = Date.now();
      await d
        .insert()
        .into(AUTHZ_ASSIGNMENT_TABLE)
        .values([
          assignment('a1', 'user:alice', 'editor', 'project', 'p1'),
          assignment('a2', 'team:t1#member', 'editor', 'task', '3'),
          assignment('a3', 'user:alice', 'editor', 'task', '4', { expiresAt: new Date(now - HOUR) }),
          assignment('a4', 'user:alice', 'billing', 'project', 'p2', { tags: ',paid,' }),
          assignment('a5', 'user:alice', 'blocked', 'org', 'o1'),
          assignment('a6', 'user:bob', 'editor', 'project', 'p3'),
          assignment('a7', 'user:alice', 'member', 'project', 'p1'),
          assignment('a8', 'user:carol', 'viewer', '$global', ''),
          assignment('a9', 'user:alice', 'viewer', 'task', '2', { expiresAt: new Date(now + HOUR) }),
        ]);
    });

    after(async () => {
      await db?.dispose();
    });

    it('matches live assignments at the row and at its ancestors', async () => {
      expect(await permit({ subjects: ['team:t1#member', 'user:alice'] })).to.deep.equal([1, 3, 5]);
      expect(await permit({ roles: [{ role: 'viewer' }] })).to.deep.equal([2]);
    });

    it('descendantsOnly, scopeTypes and tag', async () => {
      const both = ['team:t1#member', 'user:alice'];
      expect(await permit({ subjects: both, roles: [{ role: 'editor', descendantsOnly: true }] })).to.deep.equal([1, 5]);
      expect(await permit({ subjects: both, roles: [{ role: 'editor', scopeTypes: ['task'] }] })).to.deep.equal([3]);
      expect(await permit({ roles: [{ role: 'billing', tag: 'paid' }] })).to.deep.equal([2]);
      expect(await permit({ roles: [{ role: 'billing', tag: 'other' }] })).to.deep.equal([]);
    });

    it('a relation keeps the rows under the assignment whose relation column names a principal', async () => {
      const member = [{ role: 'member', relation: 'owner' as const }];
      expect(await permit({ roles: member })).to.deep.equal([1]);
      expect(await permit({ roles: member }, { owner: { column: 'owner_id', typeColumn: 'owner_type' } })).to.deep.equal([1]);
      expect(await permit({ subjects: ['user:*', 'team:t1#member'], roles: member })).to.deep.equal([]);
      expect(await permit({ roles: member }, {})).to.deep.equal([]);
    });

    it('a column relation other than owner ANDs the role with its own column', async () => {
      const worker = [{ role: 'member', relation: 'assignee' }];
      expect(await permit({ subjects: ['user:*', 'user:alice'], roles: worker }, { assignee: { column: 'owner_id' } })).to.deep.equal([1]);
      expect(await permit({ subjects: ['user:*', 'user:alice'], roles: worker })).to.deep.equal([]);
    });

    it('parses a role entry with any relation name and refuses a non-string one', () => {
      expect(parseRbacPlanArgs({ subjects: ['user:alice'], roles: [{ role: 'worker', relation: 'assignee' }], global: false }).roles).to.deep.equal([{ role: 'worker', relation: 'assignee' }]);
      expect(() => parseRbacPlanArgs({ subjects: [], roles: [{ role: 'worker', relation: 1 }], global: false })).to.throw(/roles\[0\]\.relation must be a relation name/);
    });

    it('the deny form matches at the row, an ancestor or $global', async () => {
      expect(await permit({ roles: [{ role: 'blocked' }], global: true })).to.deep.equal([1, 2, 5]);
      expect(await permit({ subjects: ['user:carol'], roles: [{ role: 'viewer' }], global: true })).to.deep.equal([1, 2, 3, 4, 5]);
      const allowed = args({ subjects: ['team:t1#member', 'user:alice'] });
      const denied = args({ roles: [{ role: 'blocked' }], global: true });
      const kept = await ids((where) => {
        where
          .where(function () {
            term.apply(allowed, this, row());
          })
          .whereNot(function () {
            term.apply(denied, this, row());
          });
      });
      expect(kept).to.deep.equal([3]);
    });

    it('a qualified role with global reads the $global branch', async () => {
      expect(await permit({ subjects: ['user:carol'], roles: [{ role: 'viewer', scopeTypes: ['$global'] }], global: true })).to.deep.equal([1, 2, 3, 4, 5]);
    });

    it('no role or no subject matches nothing', async () => {
      expect(await permit({ roles: [] })).to.deep.equal([]);
      expect(await permit({ subjects: [] })).to.deep.equal([]);
    });

    it('more than 1000 subjects bind as one list parameter and still match', async () => {
      const subjects = [...Array.from({ length: 1500 }, (_, i) => `user:filler${i}`), 'team:t1#member', 'user:alice'];
      const out = filtered((where) => term.apply(args({ subjects }), where, row())).toDB() as ICompilerOutput;
      expect(out.bindings ?? []).to.have.length.below(100);
      expect(await permit({ subjects })).to.deep.equal([1, 3, 5]);
      expect(await permit({ subjects, roles: [{ role: 'blocked' }], global: true })).to.deep.equal([1, 2, 5]);
    });

    it('correlates every sub-query with the row, in a clone too', async () => {
      const q = (name: string): string => (kind === 'sqlite' ? '`' + name + '`' : '"' + name + '"');
      const deny = args({ roles: [{ role: 'blocked' }], global: true });
      const query = filtered((where) => term.apply(deny, where, row()));
      for (const out of [query.toDB(), query.clone().toDB()] as ICompilerOutput[]) {
        expect(out.expression).to.contain(`${q('authz_d')}.${q('scope_id')} = CAST(${q(TASK)}.${q('id')} AS TEXT)`);
        expect(out.expression).to.contain(`${q('authz_a')}.${q('resource_id')} = CAST(${q(TASK)}.${q('id')} AS TEXT)`);
        expect(out.expression).to.contain(`${q('authz_a')}.${q('ancestor_type')} = ${q('authz_d')}.${q('scope_type')}`);
      }
      expect(await ids((where) => term.apply(deny, where, row()))).to.deep.equal([1, 2, 5]);
    });
  });
}
