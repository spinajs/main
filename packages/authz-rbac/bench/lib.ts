import { readFileSync } from 'node:fs';

import { AuthorizationModel, AuthzContributor, GLOBAL, SYSTEM, ScopeAttributeStore, WritableScopeAttributeStore, flattenAttributes, resourceKey, runWithPrincipal } from '@spinajs/authz';
import type { AssignmentSubject, AuthzService, Principal, ResourceFilter, ResourceRef, RuleDef } from '@spinajs/authz';
import { AbacContributor, AbacModel } from '@spinajs/authz-abac';
import { AccessResource, AuthzScopeAttribute_2026_10_02_00_00_00, DbScopeAttributeStore, ScopeColumn } from '@spinajs/authz-orm';
import { agentPrincipal, hostHarness, testHost } from '@spinajs/authz-testing';
import type { BehaviourHarness, HarnessSession, World } from '@spinajs/authz-testing';
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { QueryContext } from '@spinajs/orm';
import type { ModelBase, OrmDriver } from '@spinajs/orm';

// The kit's canvas generator and org schema (pure modules); authz-orm internals from the build the package resolves to.
import { compileResidual } from '../../authz-orm/lib/mjs/compile/compiler.js';
import { relationPrincipalOf } from '../../authz-orm/lib/mjs/principal.js';
import { branchRulePermissions, readCapabilities } from '../../authz-testing/test/canvas-c6/config.js';
import { ORG_ATTRIBUTE_SCHEMA } from '../../authz-testing/test/canvas-c6/scope.js';
import { AdminRuleStore, AssignmentStore, AuthzRbac_2026_10_01_00_00_00, RBAC_ASSIGNMENT_OP, createRbacExtensions, rbacAssignmentArgs, rbacAssignmentExtension, registerRbac } from '../src/index.js';
import type { DbRuleStore, LadderDef, RbacArgsSubject, RbacModel } from '../src/index.js';
import { RbacModelRoleGraphSource, RbacRoleGraphSource, RbacScopeAttributeSource, RbacScopeDefaults, ormRbacScopeLayers } from '../src/orm/index.js';
import { RootOrm } from '../test/orm/root-orm.js';
import type { Kind, ModelClass } from '../test/orm/root-orm.js';
import { rawQuery } from '../test/support/db.js';

import type { Scenario } from '../../authz-testing/bench/lib.js';
export type { Scenario, ScenarioResult } from '../../authz-testing/bench/lib.js';

/** A kit bench scenario with its own repeat count (slow ones repeat less). */
export interface BenchScenario extends Scenario {
  readonly repeats?: number;
}
export { formatTable, runScenario } from '../../authz-testing/bench/lib.js';

/*
 * The canvas world of design §8.5 at 1,000 files, for release gate 7: the generated config
 * (`fixtures/canvas-c6/config.snapshot.json`), orgs with the fixture's policy shapes, groups, projects with
 * default roles and grants, files with grants, restrictions (stored restrict rules) and share links, and the
 * stored branch rules (thresholds at the project). Wired as a host wires authz-orm and authz-rbac: DbAssignmentStore,
 * ConfigRuleStore + DbRuleStore, DbScopeAttributeStore, the list extension with rules, ABAC beside RBAC.
 */

const FIXTURES = new URL('../../authz-testing/fixtures/canvas-c6/', import.meta.url);
const readFixture = (name: string): any => JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8'));

export const CANVAS_CONFIG = readFixture('config.snapshot.json');
const BRANCH = branchRulePermissions(readCapabilities(readFixture('capabilities.json')));

export const PERMISSION = 'project:read';
export const DOMAIN = 'l4bbench';
export const T0 = new Date('2026-10-01T12:00:00.000Z');

export const SIZES = Object.freeze({ orgs: 10, projectsPerOrg: 5, filesPerProject: 20, groupsPerOrg: 3 });

/** The canvas dashboard's "recent files" page: `updated_at DESC, id ASC`, 50 rows. */
export const PAGE_SIZE = 50;

// The policy shapes of state.json's orgs (ACME, STRICT, OPEN) and one with external sharing off.
const POLICIES: readonly Record<string, unknown>[] = [{}, { agents_allowed: false, viewers_may_download: false, editors_may_invite: false, addons_for_guests: false, guest_max_role: 'maintainer' }, { public_links: false, max_link_role: 'viewer', maintainers_may_delete: true }, { external_sharing: false, external_max_role: 'viewer' }];

const PROJECT_ROLES = ['viewer', 'commenter', 'editor', 'maintainer'] as const;
const FILE_ROLES = ['viewer', 'commenter', 'editor'] as const;
const ADDONS = [[], ['inspect'], ['code'], ['inspect', 'code']] as const;
const BRANCH_RULES = [
  { pattern: 'main', push: 'maintainer', merge: 'maintainer' },
  { pattern: 'release/*', push: 'editor', merge: 'maintainer' },
  { pattern: '*-lts', push: 'maintainer', merge: 'maintainer' },
] as const;

const uuid = (prefix: string, n: number): string => `${prefix}000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface BenchAssignment {
  readonly subject: AssignmentSubject;
  readonly role: string;
  readonly scope: ResourceRef;
  readonly tags?: readonly string[];
}

export interface BenchPrincipal {
  /** owner, member, member-all, guest, external, link, agent */
  readonly name: string;
  readonly principal: Principal;
  readonly note: string;
}

export interface CanvasState {
  /** Orgs of other tenants (see `canvasState`). */
  readonly background: number;
  readonly orgs: readonly { readonly id: string; readonly policies: Readonly<Record<string, unknown>> }[];
  readonly groups: readonly { readonly id: string; readonly org: string }[];
  readonly projects: readonly { readonly id: string; readonly org: string }[];
  /** `updated_at`: ISO time, distinct per file, neither in id nor in insert order. */
  readonly files: readonly { readonly id: string; readonly project: string; readonly org: string; readonly name: string; readonly updated_at: string }[];
  readonly assignments: readonly BenchAssignment[];
  readonly rules: readonly Omit<RuleDef, 'source'>[];
  readonly principals: readonly BenchPrincipal[];
}

const user = (id: string): Principal => ({ type: 'user', id, authenticated: true, source: 'session', attributes: {} });

/**
 * The canvas state, deterministic for a seed. `background` more orgs (other tenants) hold the same kind of authz data
 * and org, project and group rows, but their files are not in the file table: the list still reads 1,000 files.
 */
export function canvasState(seed = 7, background = 0): CanvasState {
  const rnd = prng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
  let users = 0;
  const newUser = () => uuid('01', ++users);
  const assignments: BenchAssignment[] = [];
  // One role per subject, scope and ladder, as AuthzAdmin's replaceLadder keeps it.
  const taken = new Set<string>();
  const assign = (subject: AssignmentSubject, role: string, scope: ResourceRef, tags?: readonly string[]) => {
    const ladder = role.startsWith('org.') ? 'org' : role === 'group.member' ? 'group' : 'project';
    const key = JSON.stringify([subject, resourceKey(scope), ladder]);
    if (taken.has(key)) return;
    taken.add(key);
    assignments.push({ subject, role, scope, ...(tags && tags.length > 0 ? { tags } : {}) });
  };
  const rules: Omit<RuleDef, 'source'>[] = [];
  const orgs: { id: string; policies: Record<string, unknown> }[] = [];
  const groups: { id: string; org: string }[] = [];
  const projects: { id: string; org: string }[] = [];
  const files: { id: string; project: string; org: string; name: string; updated_at: string }[] = [];
  const externals = Array.from({ length: 30 }, newUser);
  let links = 0;

  const bench = { owner: '', member: newUser(), memberAll: newUser(), guest: newUser(), external: newUser(), link: uuid('e1', ++links) };
  const agentProjects: string[] = [];

  let fileCount = 0;
  for (let o = 0; o < SIZES.orgs + background; o++) {
    const tenant = o < SIZES.orgs;
    const org = uuid('a1', o + 1);
    const O = { type: 'org', id: org };
    orgs.push({ id: org, policies: POLICIES[o % POLICIES.length] });
    const owner = newUser();
    if (o === 0) bench.owner = owner;
    assign({ type: 'user', id: owner }, 'org.owner', O);
    const members = Array.from({ length: 20 }, newUser);
    const guests = Array.from({ length: 4 }, newUser);
    const fileGuests = Array.from({ length: 2 }, newUser);
    for (let k = 0; k < 2; k++) assign({ type: 'user', id: newUser() }, 'org.admin', O);
    for (const u of members) assign({ type: 'user', id: u }, 'org.member', O);
    for (const u of guests) assign({ type: 'user', id: u }, 'org.guest', O);
    for (const u of fileGuests) assign({ type: 'user', id: u }, 'org.file_guest', O);
    if (tenant) assign({ type: 'user', id: bench.memberAll }, 'org.member', O);
    if (o === 0 || o === 1) assign({ type: 'user', id: bench.member }, 'org.member', O);
    if (o === 1) assign({ type: 'user', id: bench.guest }, 'org.guest', O);

    const orgGroups: string[] = [];
    for (let g = 0; g < SIZES.groupsPerOrg; g++) {
      const group = uuid('d1', o * SIZES.groupsPerOrg + g + 1);
      groups.push({ id: group, org });
      orgGroups.push(group);
      for (let k = 0; k < 6; k++) assign({ type: 'user', id: pick(members) }, 'group.member', { type: 'group', id: group });
      if (o === 0 && g === 0) assign({ type: 'user', id: bench.member }, 'group.member', { type: 'group', id: group });
    }

    for (let p = 0; p < SIZES.projectsPerOrg; p++) {
      const project = uuid('b1', o * SIZES.projectsPerOrg + p + 1);
      const P = { type: 'project', id: project };
      projects.push({ id: project, org });
      if (o === 0 || o === 1) agentProjects.push(project);
      // org_default_role viewer, viewer, viewer, commenter, none; below editor its default add-ons are none
      if (p < 4) assign({ set: { role: 'org.member', scope: O } }, p < 3 ? 'viewer' : 'commenter', P);
      for (let k = 0; k < 4; k++) assign({ type: 'user', id: pick([...members, ...guests]) }, pick(PROJECT_ROLES), P, pick(ADDONS));
      assign({ set: { role: 'group.member', scope: { type: 'group', id: pick(orgGroups) } } }, 'commenter', P, ['code']);
      if (o === 0 && p === 4) assign({ type: 'user', id: bench.member }, 'editor', P, ['inspect', 'code']);
      if (o === 1 && p < 2) assign({ type: 'user', id: bench.guest }, 'maintainer', P, ['inspect', 'code']);
      if ((o === 2 || o === 3) && p === 0) assign({ type: 'user', id: bench.external }, o === 2 ? 'editor' : 'viewer', P);
      for (const b of BRANCH_RULES) {
        for (const [suffix, permissions, minRole] of [
          ['push', BRANCH.push, b.push],
          ['merge', BRANCH.merge, b.merge],
        ] as const) {
          rules.push({ id: `branch:${project}:${b.pattern}:${suffix}`, kind: 'threshold', scope: P, resourceTypes: ['branch'], resource: { attr: 'resource.name', wildcard: b.pattern }, permissions: [...permissions], minRole, reason: { code: 'branch_protected', pattern: b.pattern, needed: minRole, priority: 700, sortKey: b.pattern } } as Omit<RuleDef, 'source'>);
        }
      }
      const linkAt = (scope: ResourceRef, role: string, tags: readonly string[]) => {
        const id = o === 0 && p === 0 && scope.type === 'project' ? bench.link : uuid('e1', ++links + 100);
        assign({ type: 'link', id }, role, scope, tags);
      };
      linkAt(P, 'viewer', ['inspect']);

      for (let f = 0; f < SIZES.filesPerProject; f++) {
        const file = uuid('c1', ++fileCount);
        const F = { type: 'file', id: file };
        if (tenant) files.push({ id: file, project, org, name: `design ${fileCount}`, updated_at: '' });
        if (f === 0) linkAt(F, 'commenter', []);
        if (f % 3 === 0) assign({ type: 'user', id: pick([...members, ...guests, ...fileGuests]) }, pick(FILE_ROLES), F, pick(ADDONS));
        if (f % 10 === 5) assign({ type: 'user', id: pick(externals) }, pick(FILE_ROLES), F);
        if (o === 4 && p === 0 && f < 3) assign({ type: 'user', id: bench.external }, 'commenter', F);
        if (o === 1 && p === 4 && f === 1) assign({ type: 'user', id: bench.member }, 'editor', F);
        if (f % 15 === 7) {
          const allow: AssignmentSubject[] = [{ type: 'user', id: pick(members) }];
          if (f % 2 === 1) allow.push({ set: { role: 'group.member', scope: { type: 'group', id: pick(orgGroups) } } });
          if (o === 0 && p === 0) allow.push({ type: 'user', id: bench.member });
          rules.push({ id: `restrict:file:${file}`, kind: 'restrict', scope: F, allow } as Omit<RuleDef, 'source'>);
        }
      }
    }
  }

  // A generator of its own, so the authz data stays what the seed gave before files had a time.
  const minutes = files.map((_, i) => i + 1);
  const shuffle = prng(seed ^ 0x5eed);
  for (let i = minutes.length - 1; i > 0; i--) {
    const j = Math.floor(shuffle() * (i + 1));
    [minutes[i], minutes[j]] = [minutes[j], minutes[i]];
  }
  files.forEach((f, i) => (f.updated_at = new Date(T0.getTime() - minutes[i] * 60_000).toISOString()));

  const principals: BenchPrincipal[] = [
    { name: 'owner', principal: user(bench.owner), note: 'org.owner of org 1 (implies maintainer, bypasses restrict and cap)' },
    { name: 'member', principal: user(bench.member), note: 'org.member of orgs 1-2 (default roles), a group, a project and a file grant' },
    { name: 'member-all', principal: user(bench.memberAll), note: 'org.member of all 10 orgs' },
    { name: 'guest', principal: user(bench.guest), note: 'org.guest of org 2 (STRICT policies) with two maintainer project grants' },
    { name: 'external', principal: user(bench.external), note: 'no org role: project grants in orgs 3 (OPEN) and 4 (external sharing off), file grants in org 5' },
    { name: 'link', principal: { type: 'link', id: bench.link, authenticated: true, source: 'link', attributes: { org_only: false } }, note: 'share link: viewer at a project of org 1' },
    // Design §8.5 "Agent session" with all files of its projects, as the K1b canvas agent lists build it.
    {
      name: 'agent',
      principal: agentPrincipal(uuid('f1', 1), user(bench.member), { delegation: 'inherit', permissions: [PERMISSION], resources: agentProjects.map((id) => ({ type: 'project', id })) }),
      note: "an agent session for the member, ceiling project:read on the projects of orgs 1 (agents allowed) and 2 (agents_allowed: false): agents-disabled's ABAC scope leaves in SQL",
    },
  ];
  return { background, orgs, groups, projects, files, assignments, rules, principals };
}

/** The kit world of the domain: the §8.5 permissions and combine, ABAC's policies; the rows are authz-orm models. */
function worldOf(): World {
  return {
    now: T0,
    permissions: Object.entries(CANVAS_CONFIG.permissions as Record<string, { types: string[] }>).map(([name, def]) => ({ name, types: [...def.types] })),
    combine: CANVAS_CONFIG.combine,
    principals: {},
    config: { abac: CANVAS_CONFIG.abac },
  };
}

/**
 * The canvas types as authz-orm models with their rows: `id` TEXT and a `<type>_id` scope column per ancestor,
 * nearest first. A file is read with `project:read` (C6 `project.read`; the config has no `file:read`).
 */
async function defineCanvasModels(db: RootOrm, kind: Kind, state: CanvasState): Promise<Map<string, ModelClass>> {
  const specs: { type: string; scopes: string[]; rows: Record<string, unknown>[]; read?: string }[] = [
    { type: 'org', scopes: [], rows: state.orgs.map((o) => ({ id: o.id })) },
    { type: 'project', scopes: ['org'], rows: state.projects.map((p) => ({ id: p.id, org_id: p.org })) },
    { type: 'file', scopes: ['project', 'org'], rows: state.files.map((f) => ({ id: f.id, name: f.name, project_id: f.project, org_id: f.org, updated_at: f.updated_at })), read: PERMISSION },
    { type: 'group', scopes: ['org'], rows: state.groups.map((g) => ({ id: g.id, org_id: g.org })) },
  ];
  const out = new Map<string, ModelClass>();
  for (const spec of specs) {
    const columns: Record<string, string> = { id: 'TEXT' };
    for (const c of Object.keys(spec.rows[0])) columns[c] = c === 'updated_at' ? 'TIMESTAMP' : 'TEXT';
    const model = await db.define(
      {
        name: `Canvas_${spec.type}`,
        columns,
        rows: spec.rows,
        decorate: (cls, proto) => {
          AccessResource(spec.type, spec.read ? { permissions: { read: spec.read } } : undefined)(cls);
          for (const s of spec.scopes) ScopeColumn(`${s}_id`, s)(proto, `${s}_id`);
        },
      },
      kind,
    );
    if (spec.type === 'file') await db.raw(kind, `CREATE INDEX canvas_file_recent ON "${db.table(model)}" (updated_at DESC, id)`);
    out.set(spec.type, model);
  }
  return out;
}

const LADDERS: readonly LadderDef[] = Object.entries(CANVAS_CONFIG.rbac.ladders as Record<string, Omit<LadderDef, 'name'>>).map(([name, def]) => ({ name, ...def } as LadderDef));

/** Serves the compiler (resolved in root) for the bench's ORM models only. */
class BenchGraphSource extends RbacRoleGraphSource {
  constructor(private readonly source: () => RbacModelRoleGraphSource | undefined) {
    super();
  }

  graph(model: unknown) {
    return this.source()?.graph(model as never);
  }

  listing(model: unknown) {
    return this.source()?.listing(model as never);
  }
}

class BenchAttributeSource extends RbacScopeAttributeSource {
  constructor(private readonly models: () => ReadonlySet<unknown>) {
    super();
  }

  defaults(model: unknown, driver: OrmDriver): RbacScopeDefaults | undefined {
    return this.models().has(model) ? RbacScopeDefaults.of([ORG_ATTRIBUTE_SCHEMA], ormRbacScopeLayers(driver)) : undefined;
  }
}

class SchemaContributor extends AuthzContributor {
  contribute() {
    return { scopeAttributeSchemas: [ORG_ATTRIBUTE_SCHEMA] };
  }
}

export interface Statement {
  readonly sql: string;
  readonly bindings: readonly unknown[];
}

/** Runs `fn` and returns it with the statements `driver` ran meanwhile. */
export async function capture<T>(driver: OrmDriver, fn: () => Promise<T>): Promise<{ value: T; statements: Statement[] }> {
  const d = driver as unknown as { executeOnDb(sql: string, bindings: unknown[], context: unknown): Promise<unknown> };
  const own = Object.prototype.hasOwnProperty.call(d, 'executeOnDb');
  const before = d.executeOnDb;
  const statements: Statement[] = [];
  d.executeOnDb = function (this: unknown, sql: string, bindings: unknown[], context: unknown) {
    statements.push({ sql, bindings: [...bindings] });
    return before.call(this, sql, bindings, context);
  };
  try {
    return { value: await fn(), statements };
  } finally {
    if (own) d.executeOnDb = before;
    else delete (d as Partial<typeof d>).executeOnDb;
  }
}

const idsOf = (rows: unknown): string[] => (rows as ModelBase[]).map((r) => String((r as unknown as { id: unknown }).id));

/** Every native:rbac.assignment term of a residual. */
function assignmentTerms(f: ResourceFilter, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (f.op === 'and' || f.op === 'or') for (const a of f.args) assignmentTerms(a, out);
  else if (f.op === 'not') assignmentTerms(f.arg, out);
  else if (f.op === RBAC_ASSIGNMENT_OP) out.push((f as { args: Record<string, unknown> }).args);
  return out;
}

/**
 * The reference of gate 7: the r2 term `native:rbac.assignment` v1 (design §6.1.3, the plain `EXISTS`) for the
 * same principal without rules: the subjects of the list's args v2 and every role its routes accept.
 */
export function plainExistsResidual(residual: ResourceFilter): ResourceFilter {
  const terms = assignmentTerms(residual);
  if (terms.length === 0 || terms.some((t) => t.v !== 2)) throw new Error(`bench: the list residual holds no args v2 term to derive the reference from: ${JSON.stringify(residual)}`);
  const subjects = new Map<string, RbacArgsSubject>();
  const roles = new Set<string>();
  for (const t of terms) {
    for (const s of t.subjects as RbacArgsSubject[]) subjects.set(JSON.stringify(s), s);
    for (const r of (t.route as { roles: string[] }).roles) roles.add(r);
  }
  return { op: RBAC_ASSIGNMENT_OP, args: rbacAssignmentArgs([...subjects.values()] as AssignmentSubject[], roles) } as ResourceFilter;
}

/** The files a single check of the permission allows (the in-memory pipeline, the oracle of B44). */
export async function checkedFiles(bench: CanvasBench, principal: Principal): Promise<string[]> {
  const out: string[] = [];
  for (const f of bench.state.files) {
    const d = await bench.authz.check({ principal, permission: PERMISSION, resource: { type: 'file', id: f.id } });
    if (d.allowed) out.push(f.id);
  }
  return out;
}

const STATE_TABLES = ['authz_assignment', 'authz_rule', 'authz_rule_subject', 'authz_scope_attribute'];

export interface CanvasBench {
  readonly kind: Kind;
  readonly state: CanvasState;
  readonly driver: OrmDriver;
  readonly authz: AuthzService;
  readonly file: ModelClass;
  /** The list of `project:read` on files through authz-orm's query middleware, as an app lists. */
  list(principal: Principal): Promise<string[]>;
  /** One page of that list, `updated_at DESC, id ASC`, `PAGE_SIZE` rows from `offset`. */
  page(principal: Principal, offset: number): Promise<string[]>;
  /** A residual compiled by authz-orm on the file table and run, outside any principal's scope; with `offset`, one page of it as `page` orders it. */
  run(residual: ResourceFilter, principal: Principal, offset?: number): Promise<string[]>;
  /** The statements one list (one page with `offset`) ran. */
  statements(principal: Principal, residual?: ResourceFilter, offset?: number): Promise<Statement[]>;
  /** One statement as the driver runs it. */
  execute(s: Statement): Promise<unknown[]>;
  /** Postgres: sets `jit` for the bench database and reconnects the pool so every session has it. */
  setJit(on: boolean): Promise<void>;
  readonly jit?: boolean;
  info(): Promise<Record<string, unknown>>;
  dispose(): Promise<void>;
}

/** Boots the bench on `kind`: its own database (Postgres) or `:memory:` (SQLite), the canvas state written as a host writes it. */
export async function bootCanvasBench(kind: Kind, seed = 7, background = 0): Promise<CanvasBench> {
  const state = canvasState(seed, background);
  const world = worldOf();
  const db = await RootOrm.open(
    {
      skip: () => {
        throw new Error('bench: Postgres is unreachable');
      },
    } as unknown as Mocha.Context,
    `l4b_bench_${kind}`,
  );
  const driver = db.driver(kind);
  const undo: (() => void)[] = [];
  let session: HarnessSession | undefined;
  let harness: BehaviourHarness | undefined;
  try {
    await new AuthzRbac_2026_10_01_00_00_00().up(driver);
    await new AuthzScopeAttribute_2026_10_02_00_00_00().up(driver);
    const models = await defineCanvasModels(db, kind, state);
    const served = new Set<unknown>(models.values());
    let rbac: RbacModel | undefined;
    undo.push(testHost.registerInRoot(RbacRoleGraphSource, testHost.instance(new BenchGraphSource(() => (rbac ? new RbacModelRoleGraphSource(rbac, (m) => served.has(m)) : undefined)))));
    undo.push(testHost.registerInRoot(RbacScopeAttributeSource, testHost.instance(new BenchAttributeSource(() => served))));

    const connection = RootOrm.connectionOf(kind);
    let allowJit: (on: boolean) => void = () => undefined;
    harness = hostHarness({
      domain: DOMAIN,
      facets: ['rbac', 'ladders', 'rules', 'conditions', 'list', 'sql', 'abac', 'scopeAttributes'],
      kitScopeAttributes: false,
      async register(host) {
        const c = host.container;
        host.setConfig(['authz', 'orm', 'domain'], DOMAIN);
        allowJit = (on) => host.setConfig(['authz', 'orm', 'allowJit'], on);
        // As the SQL kit harness: on a loaded machine a check that reads the DB stores outlasts the default 2 s
        // model timeout and becomes model_error, a refusal the list does not share, and the oracle check fails.
        host.setConfig(['authz', 'domains', DOMAIN, 'engine', 'modelTimeoutMs'], 120000);
        host.setConfig(['authz', 'rbac', 'ladders'], CANVAS_CONFIG.rbac.ladders);
        host.setConfig(['authz', 'rbac', 'roles'], CANVAS_CONFIG.rbac.roles);
        host.setConfig(['authz', 'rbac', 'rules'], CANVAS_CONFIG.rbac.rules);
        host.setConfig(['authz', 'rbac', 'connection'], connection);
        host.setConfig(['authz', 'rbac', 'stores'], { roles: ['ConfigRoleStore'], assignments: ['DbAssignmentStore'], rules: ['ConfigRuleStore', 'DbRuleStore'], links: [] });

        const attributes = new DbScopeAttributeStore({ connection });
        c.register(testHost.instance(attributes)).as(ScopeAttributeStore);
        c.register(testHost.instance(attributes)).as(WritableScopeAttributeStore);
        c.register(testHost.instance(new SchemaContributor())).as(AuthzContributor);

        const configuration = (await c.resolve(Configuration)) as Configuration;
        const wired = await registerRbac(c, configuration, { extensions: (o) => [...createRbacExtensions(o), rbacAssignmentExtension(o, { rules: true })], clock: host.kit.clock });
        rbac = wired.model;
        const abac = new AbacModel();
        c.register(testHost.instance(abac)).as(AuthorizationModel);
        c.register(testHost.instance(new AbacContributor(abac))).as(AuthzContributor);

        // As AuthzAdmin's commands write them: through the stores, in one transaction on the store's connection.
        const assignments = (await c.resolve(AssignmentStore)) as unknown as { assign(a: object, actor: object, tx: object): Promise<unknown> };
        const ruleStore = (await c.resolve(AdminRuleStore)) as unknown as DbRuleStore;
        await driver.transaction(async (tx: OrmDriver) => {
          for (const a of state.assignments) await assignments.assign({ subject: a.subject, role: a.role, scope: a.scope ?? GLOBAL, ...(a.tags ? { tags: a.tags } : {}) }, SYSTEM, { driver: tx });
          for (const o of state.orgs) {
            if (Object.keys(o.policies).length > 0) await attributes.write({ type: 'org', id: o.id }, { set: flattenAttributes({ policies: o.policies }).set, remove: [] }, SYSTEM, { driver: tx });
          }
          for (const r of state.rules) await ruleStore.putWithLadders(r, LADDERS, SYSTEM, { driver: tx });
        });
      },
    });
    await harness.beforeAll?.();
    session = await harness.setup(world, { id: 'B44', part: 'bench', case: 'canvas', title: 'bench', facets: harness.facets });
    const authz = session.authz as unknown as AuthzService;
    await db.raw(kind, 'ANALYZE');
    const file = models.get('file')!;

    const paged = (q: any, offset: number | undefined) => (offset === undefined ? q : q.orderByDescending('updated_at').orderBy('id').take(PAGE_SIZE).skip(offset));
    const run = async (residual: ResourceFilter, principal: Principal, offset?: number): Promise<string[]> => {
      if (residual.op === 'false') return [];
      return runWithPrincipal(SYSTEM, async () => {
        const q = paged((file as unknown as { query(): any }).query(), offset);
        // Under inherit the residual reads principal.* from the delegate, as authz-orm's middleware compiles it.
        compileResidual(residual, q, { model: file, principal: relationPrincipalOf(principal, authz), op: 'read' });
        return idsOf(await q);
      });
    };
    let jit: boolean | undefined;
    const bench: CanvasBench = {
      kind,
      state,
      driver,
      authz,
      file,
      get jit() {
        return jit;
      },
      list: (principal) => runWithPrincipal(principal, async () => idsOf(await (file as unknown as { query(): any }).query())),
      page: (principal, offset) => runWithPrincipal(principal, async () => idsOf(await paged((file as unknown as { query(): any }).query(), offset))),
      run,
      async statements(principal, residual, offset) {
        const { statements } = await capture(driver, () => (residual ? run(residual, principal, offset) : offset === undefined ? bench.list(principal) : bench.page(principal, offset)));
        return statements;
      },
      execute: (s) => rawQuery(driver, s.sql, [...s.bindings], QueryContext.Select),
      async setJit(on) {
        if (kind !== 'postgres') throw new Error('bench: jit is a Postgres setting');
        // JIT on is measured on purpose: authz-orm refuses such a connection unless allowed.
        allowJit(on);
        await db.raw(kind, `DO $$ BEGIN EXECUTE format('ALTER DATABASE %I SET jit = ${on ? 'on' : 'off'}', current_database()); END $$`);
        // Only sessions opened after ALTER DATABASE read it: a new pool, the old one ended (its clients released).
        await driver.disconnect();
        await driver.connect();
        const got = ((await db.raw(kind, 'SHOW jit')) as { jit: string }[])[0]?.jit;
        if (got !== (on ? 'on' : 'off')) throw new Error(`bench: jit is ${got}, wanted ${on ? 'on' : 'off'}`);
        jit = on;
      },
      async info() {
        const count = async (table: string) => Number((((await db.raw(kind, `SELECT COUNT(*) AS n FROM "${table}"`)) as { n: unknown }[])[0] ?? { n: 0 }).n);
        const counts: Record<string, number> = {};
        for (const t of [...STATE_TABLES, db.table(file)]) counts[t === db.table(file) ? 'file' : t] = await count(t);
        const out: Record<string, unknown> = { counts };
        if (kind === 'postgres') {
          out.server = ((await db.raw(kind, 'SELECT version() AS v')) as { v: string }[])[0].v;
          out.settings = await db.raw(kind, "SELECT name, setting FROM pg_settings WHERE name IN ('jit', 'jit_above_cost', 'jit_inline_above_cost', 'jit_optimize_above_cost', 'work_mem', 'shared_buffers', 'random_page_cost', 'max_parallel_workers_per_gather')");
          out.indexes = await db.raw(kind, "SELECT tablename, indexname, indexdef FROM pg_indexes WHERE tablename IN ('authz_assignment', 'authz_rule', 'authz_rule_subject', 'authz_scope_attribute') OR indexname = 'canvas_file_recent' ORDER BY tablename, indexname");
        } else {
          out.server = `sqlite ${((await db.raw(kind, 'SELECT sqlite_version() AS v')) as { v: string }[])[0].v}`;
          out.indexes = await db.raw(kind, "SELECT tbl_name AS tablename, name AS indexname, sql AS indexdef FROM sqlite_master WHERE type = 'index' AND (tbl_name IN ('authz_assignment', 'authz_rule', 'authz_rule_subject', 'authz_scope_attribute') OR name = 'canvas_file_recent') ORDER BY tbl_name, name");
        }
        return out;
      },
      async dispose() {
        try {
          await session?.dispose();
          await harness?.afterAll?.();
        } finally {
          for (const u of undo.splice(0)) u();
          DI.uncache(RbacRoleGraphSource);
          DI.uncache(RbacScopeAttributeSource);
          await db.close();
        }
      },
    };
    return bench;
  } catch (e) {
    try {
      await session?.dispose();
      await harness?.afterAll?.();
    } finally {
      for (const u of undo.splice(0)) u();
      await db.close();
    }
    throw e;
  }
}
