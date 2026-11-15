import { PermissionRegistryImpl } from '@spinajs/authz';
import type { AccessPlan, ModelListPlan, Permission, Principal } from '@spinajs/authz';
import { RelationOwnerTerm, generateRls, planFilter } from '@spinajs/authz-orm';
import type { PlanTermCompiler, RlsResource } from '@spinajs/authz-orm';
import { fakeEvaluationContext, fakeModelInitContext, rlsConformance, userPrincipal } from '@spinajs/authz-testing';
import { Wrapper } from '@spinajs/orm';
import type { IWhereBuilder } from '@spinajs/orm';
import fc from 'fast-check';
import 'mocha';

import { AUTHZ_ASSIGNMENT_TABLE, MemoryAssignmentStore, MemoryRoleStore, RbacAssignmentTerm, RbacModel, RbacRlsPlanSource, RbacRlsSubjectKeys } from '../../src/index.js';
import type { Assignment, AssignmentSubject, GrantDef, RoleDef } from '../../src/index.js';
import { insertAssignment } from '../integration/db-harness.js';
import { bootDb, rawQuery } from '../support/db.js';
import type { TestDb } from '../support/db.js';

const DOCS = 'rls_conf_doc';
const ANCESTORS = 'rls_conf_ancestor';
const NOW = new Date('2026-10-14T12:00:00.000Z');
const ROLE = `spina_rls_conf_${process.pid}`;

const role = (name: string, grants: readonly (string | GrantDef)[] = [], extra: Partial<RoleDef> = {}): RoleDef => ({ name, extends: [], assignable: true, source: 'test', ...extra, grants: grants.map((g) => (typeof g === 'string' ? { permission: g } : g)) });
const ROLES = [
  role('viewer', ['doc:read']),
  role('editor', [], { extends: ['viewer'] }),
  role('pm', [{ permission: 'doc:read', grantedAt: ['project'] }], { scopeTypes: ['project', 'org'] }),
  role('member', [{ permission: 'doc:read', relation: 'owner' }]),
  role('billing', [{ permission: 'doc:read', requiresTag: 'paid' }]),
  { ...role('blocked', ['doc:read']), deny: true },
  role('team.member', [], { subjectSet: true, scopeTypes: ['team'] }),
];

// docs d1..d6 sit in projects p1..p3, p1 and p2 in org o1, p3 in o2.
const PROJECT_OF: Readonly<Record<string, string>> = { d1: 'p1', d2: 'p1', d3: 'p2', d4: 'p2', d5: 'p3', d6: 'p3' };
const ORG_OF: Readonly<Record<string, string>> = { p1: 'o1', p2: 'o1', p3: 'o2' };
const USERS = ['u1', 'u2', 'u3'];
const TEAM: AssignmentSubject = { set: { role: 'team.member', scope: { type: 'team', id: 't1' } } };

interface World {
  readonly owners: Readonly<Record<string, string | null>>;
  readonly assignments: readonly Assignment[];
}

const scopes = fc.constantFrom({ type: '$global' }, { type: 'org', id: 'o1' }, { type: 'org', id: 'o2' }, { type: 'project', id: 'p1' }, { type: 'project', id: 'p3' }, { type: 'project' }, { type: 'doc', id: 'd2' }, { type: 'doc', id: 'd5' });

// Only assignments a store accepts: pm at its scope types, team.member at the team; a tag on billing or at $global
// (a tag carried apart from its role makes the list plan refuse, as for any list). A deny role at a bare ancestor
// type is left out: checks and RLS apply it, the list plan does not (reported finding), so neither side contains the other.
const assignment = fc
  .record({ subject: fc.oneof(fc.constantFrom(...USERS).map((id): AssignmentSubject => ({ type: 'user', id })), fc.constant(TEAM)), role: fc.constantFrom('viewer', 'editor', 'pm', 'member', 'billing', 'blocked', 'team.member'), scope: scopes, tagged: fc.boolean() })
  .filter((a) => (a.role !== 'pm' || ['project', 'org'].includes(a.scope.type)) && (a.role !== 'team.member' || ('type' in a.subject && a.scope.type === '$global')) && (a.role !== 'blocked' || 'id' in a.scope || a.scope.type === '$global'))
  .map((a) => ({ ...a, scope: a.role === 'team.member' ? { type: 'team', id: 't1' } : a.scope, tags: a.tagged && (a.role === 'billing' || (a.scope.type === '$global' && a.role !== 'team.member')) ? ['paid'] : [] }));

const world: fc.Arbitrary<World> = fc.record({
  owners: fc.record(Object.fromEntries(Object.keys(PROJECT_OF).map((d) => [d, fc.constantFrom<string | null>(null, ...USERS)]))),
  assignments: fc.uniqueArray(assignment, { maxLength: 8, selector: (a) => JSON.stringify([a.subject, a.role, a.scope]) }).map((list) => list.map((a, i): Assignment => ({ id: `a${i}`, subject: a.subject, role: a.role, scope: a.scope.type === '$global' ? { type: '$global' } : a.scope, ...(a.tags.length ? { tags: a.tags } : {}), source: 'db' }))),
});

function registry() {
  const r = new PermissionRegistryImpl();
  r.register(['doc:read', 'doc:update', 'doc:delete'].map((name) => ({ name, types: ['doc'], list: true })), 'test');
  r.freeze();
  return r;
}

const asPlan = (p: ModelListPlan): AccessPlan | undefined => (p.kind === 'all' ? { kind: 'filter', permit: 'all', deny: p.deny ?? [] } : p.kind === 'terms' ? { kind: 'filter', permit: p.permit, deny: p.deny } : undefined);

/**
 * R3 for RBAC: the policy `authz:rls` generates for the docs table returns, under each principal's session settings
 * and a role RLS applies to, the rows the RBAC list plan of `.accessible('doc:read')` selects (the engine combines one
 * routed model's plan as is). Assignments at a bare type of an ancestor are the documented widening (⊇).
 */
describe('RLS conformance: RBAC (postgres)', function () {
  this.timeout(600_000);
  let db: TestDb;
  let model: RbacModel;
  const reg = registry();
  const relations = (n: string) => (n === 'owner' ? { column: 'owner_id' } : undefined);
  const compilers = new Map<string, PlanTermCompiler>([
    ['rbac.assignment', new RbacAssignmentTerm()],
    ['relation.owner', new RelationOwnerTerm()],
  ]);

  async function rebuildModel(assignments: readonly Assignment[]): Promise<void> {
    model = new RbacModel({ roles: new MemoryRoleStore(ROLES), assignments: new MemoryAssignmentStore(assignments), log: { warn: () => undefined } });
    await model.init(fakeModelInitContext({ model: 'rbac', permissions: reg, config: {} }));
    model.grantIndex();
  }

  before(async function () {
    db = await bootDb(this, 'postgres', 'rls-conformance');
    const d = db.driver;
    await d.schema().createTable(DOCS, (t) => {
      t.string('id', 64).primaryKey();
      t.string('owner_id', 64);
    });
    await d.schema().createTable(ANCESTORS, (t) => {
      t.string('resource_type', 64).notNull();
      t.string('resource_id', 64).notNull();
      t.string('ancestor_type', 64).notNull();
      t.string('ancestor_id', 64).notNull();
      t.int('depth').notNull();
    });
    const links = Object.entries(PROJECT_OF).flatMap(([doc, p]) => [
      { resource_type: 'doc', resource_id: doc, ancestor_type: 'project', ancestor_id: p, depth: 1 },
      { resource_type: 'doc', resource_id: doc, ancestor_type: 'org', ancestor_id: ORG_OF[p], depth: 2 },
    ]);
    await d.insert().into(ANCESTORS).values(links);
    await rebuildModel([]);
    const resource: RlsResource = { type: 'doc', table: DOCS, idColumn: 'id', relations, ancestorTable: ANCESTORS, mode: true };
    const out = await generateRls({ models: [model], permissions: reg, resources: [resource], sources: new Map([['rbac', new RbacRlsPlanSource()]]), compilers });
    if (out.diagnostics.length > 0) throw new Error(JSON.stringify(out.diagnostics));
    for (const sql of out.up) await rawQuery(d, sql);
    await rawQuery(d, `DROP ROLE IF EXISTS "${ROLE}"`);
    await rawQuery(d, `CREATE ROLE "${ROLE}" NOLOGIN`);
    await rawQuery(d, `GRANT USAGE ON SCHEMA public TO "${ROLE}"`);
    await rawQuery(d, `GRANT SELECT ON "${DOCS}", "${ANCESTORS}", "${AUTHZ_ASSIGNMENT_TABLE}" TO "${ROLE}"`);
  });

  after(async () => {
    if (!db) return;
    await rawQuery(db.driver, `DROP OWNED BY "${ROLE}"`).catch(() => undefined);
    await rawQuery(db.driver, `DROP ROLE IF EXISTS "${ROLE}"`).catch(() => undefined);
    await db.dispose();
  });

  async function load(w: World): Promise<void> {
    await rawQuery(db.driver, `DELETE FROM "${DOCS}"`);
    await rawQuery(db.driver, `DELETE FROM "${AUTHZ_ASSIGNMENT_TABLE}"`);
    await db.driver
      .insert()
      .into(DOCS)
      .values(Object.entries(w.owners).map(([id, owner]) => ({ id, owner_id: owner })));
    for (const a of w.assignments) await insertAssignment(db, a);
    await rebuildModel(w.assignments);
  }

  const ids = (rows: { id: unknown }[]): string[] => rows.map((r) => String(r.id)).sort();

  async function accessible(principal: Principal, permission: Permission): Promise<readonly string[]> {
    const plan = asPlan(await model.listPlan({ principal, permission: reg.require(permission), type: 'doc', env: { now: NOW } }, fakeEvaluationContext({ now: NOW })));
    if (plan === undefined) return [];
    const filter = planFilter(plan, { type: 'doc', id: Wrapper.Text('id'), relation: relations, ancestorTable: ANCESTORS, now: () => db.driver.now(), from: (table, alias) => db.driver.select<unknown>().from(table, alias) }, compilers);
    if (filter.kind === 'none') return [];
    const query = db.driver.select().select('id').from(DOCS);
    if (filter.kind === 'where')
      query.where(function (this: IWhereBuilder<unknown>) {
        filter.apply(this);
      });
    return ids(await query.asRaw<{ id: unknown }[]>());
  }

  async function rls(principal: Principal): Promise<readonly string[]> {
    const keys = await new RbacRlsSubjectKeys().keys(model, principal);
    const rows = await db.driver.transaction(async () => {
      await rawQuery(db.driver, `SET LOCAL ROLE "${ROLE}"`);
      await rawQuery(db.driver, "SELECT set_config('spina.subject_keys', ?, true), set_config('spina.principal', ?, true)", [JSON.stringify(keys), JSON.stringify([{ type: principal.type, id: principal.id }])]);
      return (await rawQuery(db.driver, `SELECT id FROM "${DOCS}"`)) as { id: unknown }[];
    });
    return ids(rows);
  }

  it('shows each principal the rows .accessible() lists, on random assignments and owners', async () => {
    await rlsConformance<World>({
      world,
      load,
      comparisons: () => USERS.map((id) => ({ principal: userPrincipal(id), permission: 'doc:read' })),
      accessible,
      rls,
      expectation: (w) => (w.assignments.some((a) => a.scope.type !== '$global' && a.scope.type !== 'doc' && a.scope.id === undefined) ? 'superset' : 'equal'),
      numRuns: Number(process.env.RLS_CONFORMANCE_RUNS ?? 40),
    });
  });
});
