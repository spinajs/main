import { AuthorizationModel, AuthzContributor, GLOBAL, principalKey, runWithPrincipal } from '@spinajs/authz';
import type { Assignment, AssignmentSubject, AuthzService, Principal, ResourceRef } from '@spinajs/authz';
import { AccessResource, ScopeColumn } from '@spinajs/authz-orm';
import { accessResourceTypeOf } from '@spinajs/authz-orm/native';
import { testHost } from '@spinajs/authz-testing';
import type { IContainer } from '@spinajs/di';
import { QueryContext } from '@spinajs/orm';
import type { ModelBase, OrmDriver } from '@spinajs/orm';

import { MemoryAssignmentStore, MemoryRoleStore, RbacContributor, RbacModel, SubjectResolver, normaliseTags, rbacAssignmentExtension, scopeToColumns, subjectToColumns } from '../../src/index.js';
import type { RbacModelOptions, RoleDef } from '../../src/index.js';
import { RbacRoleGraphSource } from '../../src/orm/index.js';
import type { RoleGraph } from '../../src/index.js';
import { rawQuery } from '../support/db.js';
import type { Kind, ModelClass, RootOrm } from './root-orm.js';

export const user = (id: string): Principal => ({ type: 'user', id, authenticated: true, source: 'session', attributes: {} });

const role = (name: string, extra: Partial<RoleDef> = {}): RoleDef => ({ name, extends: [], assignable: true, source: 'test', grants: [{ permission: 'doc:read' }], ...extra });

export const ROLES: readonly RoleDef[] = [role('viewer'), role('editor', { grants: [{ permission: 'doc:edit' }] }), role('orgOnly', { scopeTypes: ['org'] }), role('team.member', { subjectSet: true, scopeTypes: ['team'], grants: [] })];

const DAY = 24 * 3600 * 1000;
const at = (type: string, id?: string): ResourceRef => (id === undefined ? { type } : { type, id });
const u = (id: string): AssignmentSubject => ({ type: 'user', id });
const T1_MEMBERS: AssignmentSubject = { set: { role: 'team.member', scope: at('team', 't1') } };

/** Doc rows: integer ids and project ids, string org ids, NULL and '' ancestors, an org id differing only by case. */
export const ORM_DOCS: readonly Readonly<Record<string, unknown>>[] = [
  { id: 1, project_id: 10, org_id: 'o1' },
  { id: 2, project_id: 10, org_id: 'o2' },
  { id: 3, project_id: 11, org_id: 'o1' },
  { id: 4, project_id: null, org_id: 'o2' },
  { id: 5, project_id: 12, org_id: null },
  { id: 6, project_id: 13, org_id: '' },
  { id: 7, project_id: 10, org_id: 'O1' },
  { id: 8, project_id: 11, org_id: 'o10' },
];

/** SQLite only: ids the adapter cannot read as an id of the integer column, so it finds no row by them. */
export const SQLITE_ODD_DOCS: readonly Readonly<Record<string, unknown>>[] = [
  { id: 'x9', project_id: 10, org_id: 'o1' },
  { id: 9.5, project_id: 10, org_id: 'o1' },
  { id: 20, project_id: 'p10', org_id: 'o1' },
];

export function assignments(now: Date): Assignment[] {
  let n = 0;
  const a = (subject: AssignmentSubject, assigned: string, scope: ResourceRef, expiresAt: Date | null = null): Assignment => ({ id: `x${++n}`, subject, role: assigned, scope, expiresAt, source: 'db' });
  return [
    a(u('alice'), 'viewer', at('org', 'o1')), // docs 1, 3: not 'O1', not 'o10'
    a(u('bob'), 'team.member', at('team', 't1')),
    a(T1_MEMBERS, 'viewer', at('project', '10')), // bob through the set: docs 1, 2, 7
    a(u('carol'), 'viewer', at('doc', '3')),
    a(u('carol'), 'editor', at('project', '12')), // no doc:read
    a(u('dave'), 'orgOnly', at('project', '11')), // refused by the role's scope types
    a(u('dave'), 'orgOnly', at('org', 'o2')), // docs 2, 4
    a(u('erin'), 'viewer', at('org')), // another type's type-only scope: no doc
    a(u('frank'), 'viewer', at('doc')), // the row type's type-only scope: every doc
    a(u('gina'), 'viewer', GLOBAL),
    a(u('hank'), 'viewer', at('org', 'o1'), new Date(now.getTime() - DAY)), // expired
    a(u('hank'), 'viewer', at('project', '13'), new Date(now.getTime() + DAY)), // doc 6
    a(u('kim'), 'viewer', at('project', '010')), // not project 10
    a(u('lena'), 'viewer', at('project', 'p10')), // a project id only text in an integer column holds
    a(u('lena'), 'viewer', at('doc', 'x9')),
    a(u('mia'), 'viewer', at('project', '11')), // the two-model case: rows of later doc models
  ];
}

/** bob is in the team t1 member set. */
class TeamSubjects extends SubjectResolver {
  subjects(p: Principal): readonly AssignmentSubject[] {
    return [{ type: p.type, id: p.id }, ...(p.id === 'bob' ? [T1_MEMBERS] : [])];
  }
}

export const PRINCIPALS = ['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'gina', 'hank', 'ivan', 'kim', 'lena'].map(user);

/** A case-insensitive collation on Postgres (needs ICU): equality ignores case unless the SQL says otherwise. */
export async function createCaseInsensitiveCollation(driver: OrmDriver): Promise<string> {
  await rawQuery(driver, `CREATE COLLATION IF NOT EXISTS l4b_ci (provider = icu, locale = 'und-u-ks-level2', deterministic = false)`, [], QueryContext.Schema);
  return 'l4b_ci';
}

/**
 * §9.1 `authz_assignment`, its `scope_id` case-insensitive (SQLite NOCASE, a nondeterministic collation on
 * Postgres), so only the SQL's own binary comparison keeps 'O1' apart from 'o1'.
 */
export async function createAssignmentTable(driver: OrmDriver, kind: Kind): Promise<void> {
  if (kind === 'sqlite') {
    await rawQuery(driver, `CREATE TABLE "authz_assignment" ("id" VARCHAR(36) NOT NULL PRIMARY KEY, "subject_type" VARCHAR(32) NOT NULL, "subject_id" VARCHAR(64) NOT NULL, "subject_role" VARCHAR(128) NOT NULL DEFAULT '', "role" VARCHAR(128) NOT NULL, "scope_type" VARCHAR(64) NOT NULL DEFAULT '$global', "scope_id" VARCHAR(64) COLLATE NOCASE NOT NULL DEFAULT '', "tags" VARCHAR(512) NOT NULL DEFAULT '', "expires_at" DATETIME, "granted_by" VARCHAR(100), "source" VARCHAR(32) NOT NULL DEFAULT 'db', "created_at" DATETIME NOT NULL)`, [], QueryContext.Schema);
    return;
  }
  await driver.schema().createTable('authz_assignment', (t) => {
    t.string('id', 36).primaryKey().notNull();
    t.string('subject_type', 32).notNull();
    t.string('subject_id', 64).notNull();
    t.string('subject_role', 128).notNull().default().value('');
    t.string('role', 128).notNull();
    t.string('scope_type', 64).notNull().default().value('$global');
    t.string('scope_id', 64).notNull().default().value('');
    t.string('tags', 512).notNull().default().value('');
    t.dateTime('expires_at');
    t.string('granted_by', 100);
    t.string('source', 32).notNull().default().value('db');
    t.dateTime('created_at').notNull();
  });
  const ci = await createCaseInsensitiveCollation(driver);
  await rawQuery(driver, `ALTER TABLE "authz_assignment" ALTER COLUMN "scope_id" TYPE VARCHAR(64) COLLATE ${ci}`, [], QueryContext.Schema);
}

/** As DbAssignmentStore writes them. */
export async function insertAssignments(driver: OrmDriver, rows: readonly Assignment[]): Promise<void> {
  for (const a of rows) {
    await driver
      .insert()
      .into('authz_assignment')
      .values({ id: a.id, ...subjectToColumns(a.subject), role: a.role, ...scopeToColumns(a.scope), tags: normaliseTags(a.tags), expires_at: a.expiresAt ?? null, granted_by: a.grantedBy ? principalKey(a.grantedBy) : null, source: a.source ?? 'db', created_at: new Date() });
  }
}

export interface DocModels {
  readonly Org: ModelClass;
  readonly Project: ModelClass;
  readonly Doc: ModelClass;
}

/** org ← project ← doc as authz-orm models; Doc's ancestors: its project, then its org. With `names`, docs have a `name` text column. */
export async function defineDocModels(db: RootOrm, kind: Kind, extraDocs: readonly Readonly<Record<string, unknown>>[] = [], names?: Readonly<Record<string, string | null>>): Promise<DocModels> {
  const Org = await db.define({ name: 'Org', columns: { id: 'TEXT' }, rows: [{ id: 'o1' }, { id: 'o2' }], decorate: (cls) => AccessResource('org')(cls) }, kind);
  const Project = await db.define(
    {
      name: 'Project',
      columns: { id: 'INT', org_id: 'TEXT' },
      rows: [10, 11, 12, 13].map((id) => ({ id, org_id: 'o1' })),
      decorate: (cls, proto) => {
        AccessResource('project')(cls);
        ScopeColumn('org_id', 'org')(proto, 'org_id');
      },
    },
    kind,
  );
  const Doc = await db.define(
    {
      name: 'Doc',
      columns: { id: 'INT', project_id: 'INT', org_id: 'TEXT', ...(names ? { name: 'TEXT' } : {}) },
      rows: [...ORM_DOCS, ...extraDocs].map((d) => (names ? { ...d, name: names[String(d.id)] ?? null } : d)),
      decorate: (cls, proto) => {
        AccessResource('doc')(cls);
        ScopeColumn('project_id', 'project')(proto, 'project_id');
        ScopeColumn('org_id', 'org')(proto, 'org_id');
      },
    },
    kind,
  );
  return { Org, Project, Doc };
}

/** The model whose role graph the compiler reads, for the ORM model its residuals filter. */
export const current: { model?: RbacModel; Doc?: ModelClass } = {};

export class CurrentRoleGraphSource extends RbacRoleGraphSource {
  graph(model: unknown): RoleGraph | undefined {
    return current.model !== undefined && accessResourceTypeOf(model as never) === 'doc' ? current.model.roleGraph() : undefined;
  }
}

let domainSeq = 0;

/** A test domain with L1's RbacModel and rbacAssignmentExtension over the assignments; `authz.orm.domain` names it. */
export async function rbacDomain(rows: readonly Assignment[], Doc: ModelClass): Promise<{ service: AuthzService; model: RbacModel; container: IContainer; dispose(): Promise<void> }> {
  const ds = await testHost.domains();
  const cfg = testHost.config();
  const name = `l4borm${++domainSeq}`;
  const permissions = Object.fromEntries(['doc:read', 'doc:edit'].map((p) => [p, { types: ['doc'] }]));
  cfg.set(['authz', 'domains', name], { permissions, combine: { default: { algorithm: 'deny-overrides', models: ['rbac'] } }, cache: { maxEntries: 0 } });
  const domainBefore = cfg.get<unknown>(['authz', 'orm', 'domain']);
  cfg.set(['authz', 'orm', 'domain'], name);
  const options: RbacModelOptions = { roles: new MemoryRoleStore(ROLES), assignments: new MemoryAssignmentStore(rows), subjects: new TeamSubjects() };
  const model = new RbacModel({ ...options, extensions: [rbacAssignmentExtension(options)] });
  const container = ds.create(name, 'root');
  container.register(testHost.instance(model)).as(AuthorizationModel);
  container.register(testHost.instance(new RbacContributor(model))).as(AuthzContributor);
  const service = await ds.service(name);
  current.model = model;
  current.Doc = Doc;
  return {
    service,
    model,
    container,
    dispose: async () => {
      current.model = undefined;
      current.Doc = undefined;
      if (ds.names().includes(name)) await container.dispose();
      cfg.unset(['authz', 'domains', name]);
      if (domainBefore === undefined) cfg.unset(['authz', 'orm', 'domain']);
      else cfg.set(['authz', 'orm', 'domain'], domainBefore);
    },
  };
}

export const idsOf = (rows: unknown): string[] => (rows as ModelBase[]).map((r) => String((r as unknown as { id: unknown }).id)).sort();

export const as = <T>(p: Principal, fn: () => T | Promise<T>): Promise<T> => runWithPrincipal(p, async () => fn());
