import { AuthzClock, GLOBAL } from '@spinajs/authz';
import type { Assignment, AssignmentSubject, Principal, ResourceRef } from '@spinajs/authz';
import { FakeScopeResolver, fakeEvaluationContext } from '@spinajs/authz-testing';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import '@spinajs/log';
import { ModelBase, Orm, QueryContext } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';
import { PostgresOrmDriver } from '@spinajs/orm-postgres';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { randomBytes } from 'node:crypto';
import _ from 'lodash';
import { expect } from 'chai';

import { MemoryAssignmentStore, RbacAssignmentFilter, compileRoles, rbacAssignmentArgs } from '../../src/index.js';
import type { RbacAssignmentArgs, RoleDef, RoleGraph } from '../../src/index.js';
import { RbacOrmCompiler, RbacRoleGraphSource, RbacScopePathSource } from '../../src/orm/index.js';
import type { RbacScopePath } from '../../src/orm/index.js';

// Undecorated on purpose: the compiler takes the model only as a key for the path source.
export class DocModel extends ModelBase {}
export class UnscopedModel extends ModelBase {}

export const DOC_PATH: RbacScopePath = {
  type: 'doc',
  idColumn: 'id',
  scopes: [
    { column: 'project_id', scopeType: 'project' },
    { column: 'org_id', scopeType: 'org' },
  ],
};

export class FixturePathSource extends RbacScopePathSource {
  path(model: unknown): RbacScopePath | null {
    return model === DocModel ? DOC_PATH : null;
  }
}

const role = (name: string, extra: Partial<RoleDef> = {}): RoleDef => ({ name, extends: [], assignable: true, source: 'test', grants: [{ permission: 'doc:read' }], ...extra });

/** `ghost` has no definition on purpose: its assignments must never count. */
export const ROLE_DEFS: readonly RoleDef[] = [role('viewer'), role('editor'), role('commenter'), role('orgOnly', { scopeTypes: ['org'] }), role('projectLead', { scopeTypes: ['project', '$global'] }), role('docOnly', { scopeTypes: ['doc'] }), role('fixed', { assignable: false })];
export const GRAPH: RoleGraph = compileRoles(ROLE_DEFS);

export class FixtureRoleGraphSource extends RbacRoleGraphSource {
  graph(): RoleGraph {
    return GRAPH;
  }
}

export const NOW = new Date('2026-06-01T12:00:00.000Z');
const HOUR = 3600 * 1000;

export class FixedClock extends AuthzClock {
  now(): Date {
    return NOW;
  }
}

export const principal = (id: string): Principal => ({ type: 'user', id, authenticated: true, source: 'session', attributes: {} });

/** A child container with the fixture path source, role graph and clock; the compiler reads them from it. */
export function compilerContainer(): { container: IContainer; compiler: RbacOrmCompiler } {
  const container = DI.child();
  container.register(FixturePathSource).as(RbacScopePathSource);
  container.register(FixtureRoleGraphSource).as(RbacRoleGraphSource);
  container.register(FixedClock).as(AuthzClock);
  return { container, compiler: new RbacOrmCompiler(container) };
}

const LOGGER = {
  targets: [{ name: 'Empty', type: 'BlackHoleTarget' }],
  rules: [{ name: '*', level: 'trace', target: 'Empty' }],
};

const mergeArrays = (target: unknown, source: unknown) => (Array.isArray(target) ? target.concat(source) : undefined);

function confFor(connection: Record<string, unknown>) {
  return class extends FrameworkConfiguration {
    public async resolve(): Promise<void> {
      await super.resolve();
      _.mergeWith(this.Config, { logger: LOGGER, db: { DefaultConnection: connection.Name, Connections: [connection] } }, mergeArrays);
    }
  };
}

export interface BootedDb {
  readonly driver: OrmDriver;
  close(): Promise<void>;
}

/** Boots an Orm in a child container, as an app would, so nothing leaks into the root container. */
async function bootOrm(connection: Record<string, unknown>, driverClass: unknown): Promise<BootedDb> {
  const container = DI.child();
  container.register(confFor(connection)).as(Configuration);
  container.register(driverClass as never).as(connection.Driver as string);
  await container.resolve(Configuration);
  const orm = await container.resolve(Orm);
  const driver = orm.Connections.get(connection.Name as string)!;

  return {
    driver,
    close: async () => {
      for (const c of new Set(orm.Connections.values())) {
        await c.disconnect();
      }
      await container.dispose();
    },
  };
}

export const bootSqlite = (): Promise<BootedDb> => bootOrm({ Driver: 'orm-driver-sqlite', Filename: ':memory:', Name: 'l2-orm-sqlite' }, SqliteOrmDriver);

export const PG = { Host: '127.0.0.1', Port: 15432, User: 'postgres', Password: 'postgres' };

/** Creates its own database on the shared server; resolves null when the server is unreachable. */
export async function bootPostgres(): Promise<(BootedDb & { database: string }) | null> {
  const database = `l2_orm_${randomBytes(4).toString('hex')}`;
  let admin: BootedDb;
  try {
    admin = await bootOrm({ Driver: 'orm-driver-postgres', Name: 'l2-orm-pg-admin', Database: 'test', ...PG }, PostgresOrmDriver);
  } catch {
    return null;
  }

  await (admin.driver as PostgresOrmDriver).executeOnDb(`CREATE DATABASE "${database}"`, [], QueryContext.Schema);
  // authz-orm refuses a connection with jit on unless authz.orm.allowJit; a host turns jit off like this.
  await (admin.driver as PostgresOrmDriver).executeOnDb(`ALTER DATABASE "${database}" SET jit = off`, [], QueryContext.Schema);
  const db = await bootOrm({ Driver: 'orm-driver-postgres', Name: 'l2-orm-pg', Database: database, ...PG }, PostgresOrmDriver);

  return {
    database,
    driver: db.driver,
    close: async () => {
      await db.close();
      await (admin.driver as PostgresOrmDriver).executeOnDb(`DROP DATABASE IF EXISTS "${database}"`, [], QueryContext.Schema);
      await admin.close();
    },
  };
}

/** §9.1 `authz_assignment`, created here because the real migration lives on the other L2 track. */
export async function createSchema(driver: OrmDriver): Promise<void> {
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

  // int row ids and project ids, string org ids: the compiler must compare both against varchar scope_id;
  // org_id is wider than scope_id so a row can hold an id the cast must not cut
  await driver.schema().createTable('doc', (t) => {
    t.int('id').primaryKey().notNull();
    t.int('project_id').notNull();
    t.string('org_id', 128).notNull();
  });
}

const ORG_PREFIX = `org-${'p'.repeat(60)}`;
const LONG_ORG = `${ORG_PREFIX}-extra`;

/** [id, project_id, org_id] */
export const DOCS: ReadonlyArray<[number, number, string]> = [
  [1, 10, 'o1'],
  [2, 11, 'o1'],
  [3, 12, 'o2'],
  [4, 13, 'o2'],
  [5, 14, 'o3'],
  [6, 15, 'o3'],
  [7, 16, 'o4'],
  [8, 17, 'o5'],
  [9, 18, LONG_ORG], // 70 characters, sharing its first 64 with doc 10's org
  [10, 19, ORG_PREFIX],
  [11, 20, ''], // an empty ancestor id
];

export const ALL_DOCS = DOCS.map(([id]) => id);

const user = (id: string): AssignmentSubject => ({ type: 'user', id });
const set = (setRole: string, scope: ResourceRef): AssignmentSubject => ({ set: { role: setRole, scope } });
const at = (type: string, id?: string): ResourceRef => (id === undefined ? { type } : { type, id });

export const U1 = user('u1');
export const U2 = user('u2');
export const U3 = user('u3');
export const U4 = user('u4');
export const U5 = user('u5');
export const ADMIN = user('admin');
export const TEAM_T1 = { type: 'team', id: 't1' };
export const T1_MEMBERS = set('team.member', TEAM_T1);
export const T1_ADMINS = set('team.admin', TEAM_T1);
export const STAFF = set('staff', GLOBAL);
export const TEAM_LEADS = set('team.lead', at('team'));

let seq = 0;
const assignment = (subject: AssignmentSubject, assigned: string, scope: ResourceRef, expiresAt: Date | null = null): Assignment => ({ id: `a${++seq}`, subject, role: assigned, scope, expiresAt, source: 'db' });

/** One list for both sides of the parity test: the SQL compiler reads it from the table, the in-memory filter from a MemoryAssignmentStore. */
export const ASSIGNMENTS: readonly Assignment[] = [
  assignment(ADMIN, 'viewer', GLOBAL), // global grant: every doc
  assignment(U1, 'viewer', at('doc', '1')), // at the row: doc 1
  assignment(U1, 'commenter', at('doc', '2')), // wrong role: not doc 2
  assignment(U1, 'viewer', at('doc', '2'), NOW), // expires exactly now: not doc 2
  assignment(U1, 'editor', at('project', '12')), // at the project: doc 3
  assignment(U1, 'viewer', at('doc', '4'), new Date(NOW.getTime() - HOUR)), // expired: not doc 4
  assignment(U1, 'viewer', at('org', 'o3')), // at the org: docs 5, 6
  assignment(U2, 'viewer', at('doc', '7')), // other subject: not doc 7
  assignment(T1_ADMINS, 'viewer', at('doc', '7')), // a set u1 is not in: not doc 7
  assignment(TEAM_T1, 'viewer', at('doc', '7')), // the team as a principal, not the member set: not doc 7
  assignment(T1_MEMBERS, 'viewer', at('project', '17'), new Date(NOW.getTime() + 24 * HOUR)), // subject set, live: doc 8
  assignment(U1, 'viewer', at('project', '999')), // on no doc's path
  // u3: what the role definitions accept
  assignment(U3, 'orgOnly', at('org', 'o1')), // accepted: docs 1, 2
  assignment(U3, 'orgOnly', at('project', '13')), // wrong scope type: not doc 4
  assignment(U3, 'orgOnly', GLOBAL), // $global not in scopeTypes: no doc
  assignment(U3, 'fixed', at('doc', '5')), // not assignable: not doc 5
  assignment(U3, 'ghost', at('doc', '6')), // no definition: not doc 6
  assignment(U3, 'projectLead', at('project', '16')), // accepted: doc 7
  assignment(U3, 'projectLead', at('org', 'o5')), // wrong scope type: not doc 8
  assignment(U3, 'docOnly', at('doc')), // type-only scope of the row type, accepted: every doc
  // u4: type-only scopes
  assignment(U4, 'viewer', at('doc')), // every doc
  assignment(U4, 'editor', at('project')), // another type's type-only scope: no doc
  assignment(STAFF, 'editor', at('doc', '8')), // a set at GLOBAL: doc 8
  assignment(TEAM_LEADS, 'viewer', at('doc', '3')), // a set at a type-only scope: doc 3
  // u5: ids the SQL must compare in full
  assignment(U5, 'viewer', at('org', ORG_PREFIX)), // doc 10, not doc 9 whose org id only starts with it
  assignment(U5, 'editor', at('org')), // the org type-only scope: no doc, not even doc 11 with org id ''
];

/** D-L2-7, as the assignment store writes it. */
function toRow(a: Assignment): Record<string, unknown> {
  const scopeColumns = (s: ResourceRef) => (s.type === GLOBAL.type ? [GLOBAL.type, ''] : [s.type, s.id ?? '']);
  const [subjectType, subjectId, subjectRole] = 'set' in a.subject ? [...scopeColumns(a.subject.set.scope), a.subject.set.role] : [a.subject.type, a.subject.id, ''];
  const [scopeType, scopeId] = scopeColumns(a.scope);
  return { id: a.id, subject_type: subjectType, subject_id: subjectId, subject_role: subjectRole, role: a.role, scope_type: scopeType, scope_id: scopeId, tags: '', expires_at: a.expiresAt ?? null, granted_by: null, source: a.source, created_at: NOW };
}

export async function seed(driver: OrmDriver): Promise<void> {
  for (const [id, projectId, orgId] of DOCS) {
    await driver.insert().into('doc').values({ id, project_id: projectId, org_id: orgId });
  }
  for (const a of ASSIGNMENTS) {
    await driver.insert().into('authz_assignment').values(toRow(a));
  }
}

export const args = (subjects: readonly AssignmentSubject[], roles: readonly string[]): RbacAssignmentArgs => rbacAssignmentArgs(subjects, roles);

export const U1_ARGS = args([U1, T1_MEMBERS], ['viewer', 'editor']);

export async function visibleDocs(driver: OrmDriver, compiler: RbacOrmCompiler, termArgs: unknown, alias?: string, who: Principal = principal('u1')): Promise<number[]> {
  const query = driver.select<Array<{ id: number }>>().from('doc', alias).columns(['id']).orderBy('id');
  compiler.compile(termArgs, query, DocModel, who);
  const rows = (await query) as unknown as Array<{ id: number | string }>;
  return rows.map((r) => Number(r.id));
}

/** L1's in-memory evaluator of the same term over the same assignments and doc tree. */
export async function docsInMemory(termArgs: RbacAssignmentArgs): Promise<number[]> {
  const nodes = DOCS.flatMap(([id, projectId, orgId]) => [
    { ref: at('doc', String(id)), parent: at('project', String(projectId)) },
    { ref: at('project', String(projectId)), parent: at('org', orgId) },
  ]);
  const ctx = fakeEvaluationContext({ now: NOW, scopeResolvers: [new FakeScopeResolver({ nodes })] });
  const filter = new RbacAssignmentFilter(new MemoryAssignmentStore(ASSIGNMENTS), () => GRAPH);
  const out: number[] = [];
  for (const [id] of DOCS) {
    if (await filter.matches(termArgs, undefined, at('doc', String(id)), ctx)) out.push(id);
  }
  return out;
}

/** The execution cases, shared by the sqlite and postgres suites. */
export function executionCases(db: () => OrmDriver): void {
  const { compiler } = compilerContainer();

  it('returns the docs reached through the row, its project, its org and a subject set', async () => {
    expect(await visibleDocs(db(), compiler, U1_ARGS)).to.deep.equal([1, 3, 5, 6, 8]);
  });

  it('a $global assignment reaches every doc', async () => {
    expect(await visibleDocs(db(), compiler, args([ADMIN], ['viewer']))).to.deep.equal(ALL_DOCS);
  });

  it('only the roles in args count', async () => {
    expect(await visibleDocs(db(), compiler, args([U1, T1_MEMBERS], ['editor']))).to.deep.equal([3]);
    expect(await visibleDocs(db(), compiler, args([U1, T1_MEMBERS], ['commenter']))).to.deep.equal([2]);
  });

  it('only the subjects in args count', async () => {
    expect(await visibleDocs(db(), compiler, args([U2], ['viewer']))).to.deep.equal([7]);
    expect(await visibleDocs(db(), compiler, args([T1_MEMBERS], ['viewer']))).to.deep.equal([8]);
    expect(await visibleDocs(db(), compiler, args([STAFF], ['editor']))).to.deep.equal([8]);
    expect(await visibleDocs(db(), compiler, args([TEAM_LEADS], ['viewer']))).to.deep.equal([3]);
  });

  it('compares ids in full: an id longer than 64 characters does not match an assignment at its prefix', async () => {
    expect(await visibleDocs(db(), compiler, args([U5], ['viewer']))).to.deep.equal([10]);
  });

  it("an empty ancestor id does not reach that type's type-only scope", async () => {
    expect(await visibleDocs(db(), compiler, args([U5], ['editor']))).to.deep.equal([]);
  });

  it('empty roles or subjects match nothing', async () => {
    expect(await visibleDocs(db(), compiler, args([U1, T1_MEMBERS], []))).to.deep.equal([]);
    expect(await visibleDocs(db(), compiler, args([], ['viewer', 'editor']))).to.deep.equal([]);
  });

  it('counts an assignment only where its role definition accepts it', async () => {
    expect(await visibleDocs(db(), compiler, args([U3], ['orgOnly']))).to.deep.equal([1, 2]);
    expect(await visibleDocs(db(), compiler, args([U3], ['projectLead']))).to.deep.equal([7]);
    expect(await visibleDocs(db(), compiler, args([U3], ['fixed', 'ghost']))).to.deep.equal([]);
    expect(await visibleDocs(db(), compiler, args([U3], ['fixed', 'ghost', 'orgOnly', 'projectLead']))).to.deep.equal([1, 2, 7]);
    expect(await visibleDocs(db(), compiler, args([U3], ['docOnly']))).to.deep.equal(ALL_DOCS);
  });

  it('a type-only scope reaches the rows of its own type only', async () => {
    expect(await visibleDocs(db(), compiler, args([U4], ['viewer']))).to.deep.equal(ALL_DOCS);
    expect(await visibleDocs(db(), compiler, args([U4], ['editor']))).to.deep.equal([]);
  });

  it('correlates with an aliased outer table', async () => {
    expect(await visibleDocs(db(), compiler, U1_ARGS, 'd')).to.deep.equal([1, 3, 5, 6, 8]);
  });

  it('an expired assignment stops counting at the clock time, not at SQL now()', async () => {
    const { container } = compilerContainer();
    container
      .register(
        class extends AuthzClock {
          now(): Date {
            return new Date(NOW.getTime() - 2 * HOUR);
          }
        },
      )
      .as(AuthzClock);
    expect(await visibleDocs(db(), new RbacOrmCompiler(container), U1_ARGS)).to.deep.equal([1, 2, 3, 4, 5, 6, 8]);
  });
}

const SUBJECT_POOL: readonly AssignmentSubject[] = [U1, U2, U3, U4, U5, ADMIN, TEAM_T1, T1_MEMBERS, T1_ADMINS, STAFF, TEAM_LEADS, user('u9')];
const ROLE_POOL = ['viewer', 'editor', 'commenter', 'orgOnly', 'projectLead', 'docOnly', 'fixed', 'ghost'] as const;

/** Each subject alone with every role, every subject with each role alone, then seeded random picks of both. */
export function parityArgs(): RbacAssignmentArgs[] {
  const out = [...SUBJECT_POOL.map((s) => args([s], ROLE_POOL)), ...ROLE_POOL.map((r) => args(SUBJECT_POOL, [r]))];
  let state = 0x2545f491;
  const next = () => (state = (Math.imul(state, 1103515245) + 12345) >>> 0);
  const pick = <T>(pool: readonly T[]) => pool.filter(() => next() % 3 === 0);
  for (let i = 0; i < 40; i++) out.push(args(pick(SUBJECT_POOL), pick(ROLE_POOL)));
  return out;
}

/** B06 for this term: the SQL compiler lists exactly the rows L1's in-memory filter permits. */
export function parityCases(db: () => OrmDriver): void {
  const { compiler } = compilerContainer();

  it('lists the same docs as the in-memory RbacAssignmentFilter (B06)', async () => {
    let nonEmpty = 0;
    for (const termArgs of parityArgs()) {
      const expected = await docsInMemory(termArgs);
      if (expected.length > 0) nonEmpty++;
      expect(await visibleDocs(db(), compiler, termArgs), JSON.stringify(termArgs)).to.deep.equal(expected);
    }
    expect(nonEmpty, 'cases that list something').to.be.greaterThan(20);
  });

  it('long ids, empty ancestor ids and type-only scopes give the same rows on both sides', async () => {
    for (const termArgs of [args([U5], ['viewer']), args([U5], ['editor']), args([U5, U4], ['editor', 'viewer']), args([TEAM_LEADS], ['viewer'])]) {
      expect(await visibleDocs(db(), compiler, termArgs), JSON.stringify(termArgs)).to.deep.equal(await docsInMemory(termArgs));
    }
    expect(await docsInMemory(args([U5], ['viewer']))).to.deep.equal([10]);
  });

  it('the planted rows the role definitions refuse are refused by both', async () => {
    const refused = args([U3], ['fixed', 'ghost']);
    expect(await docsInMemory(refused)).to.deep.equal([]);
    expect(await visibleDocs(db(), compiler, refused)).to.deep.equal([]);
    const wrongScope = args([U3], ['orgOnly', 'projectLead']);
    expect(await docsInMemory(wrongScope)).to.deep.equal([1, 2, 7]);
    expect(await visibleDocs(db(), compiler, wrongScope)).to.deep.equal([1, 2, 7]);
  });
}
