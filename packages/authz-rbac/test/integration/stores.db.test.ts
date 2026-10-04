import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';

import { AuthzClock, AuthzConfigError, CORE_FILTER_OPS, GLOBAL, SYSTEM } from '@spinajs/authz';
import type { AuthzService, Permission, ResourceFilter } from '@spinajs/authz';
import { BEHAVIOUR_FIXTURES, fixtureDsl, modelSteps, runBehaviour, testHost, userPrincipal } from '@spinajs/authz-testing';
import type { DecisionExpectation, HostSetup, Step, StepContext, World } from '@spinajs/authz-testing';
import { Configuration } from '@spinajs/configuration';
import { QueryContext } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';

import { AssignCommand, RevokeCommand } from '../../src/cli/index.js';
import { AuthzAdminIdempotency_2026_10_02_00_01_00, AuthzRbac_2026_10_01_00_00_00, DbAssignmentStore, DbAuthzAdminBackend, RBAC_ASSIGNMENT_OP, RbacModelRoleGraphSource, RbacOrmCompiler, RbacRoleGraphSource, RbacScopePathSource, rbacAssignmentExtension, readVersion } from '../../src/index.js';
import type { RbacModel } from '../../src/index.js';
import { capture } from '../cli/fixture.js';
import { DocModel, FixturePathSource } from '../orm/fixture.js';
import { bootDb, DB_KINDS, rawQuery } from '../support/db.js';
import type { TestDb } from '../support/db.js';
import { activeDb, dbHarness } from './db-harness.js';
import type { DbHarnessStores } from './db-harness.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

const { assignment, combine, extension, ref, role } = fixtureDsl;
const RUN = { strict: true, timeoutMs: 60_000 };

const NOW = new Date('2026-10-01T12:00:00.000Z');
const HOUR = 3_600_000;
const O1 = ref('org', 'o1');
const O2 = ref('org', 'o2');
const P1 = ref('project', 'p1');
const P2 = ref('project', 'p2');
const P3 = ref('project', 'p3');
const doc = (id: string) => ref('doc', id);

const alice = userPrincipal('alice');
const bob = userPrincipal('bob');
const carol = userPrincipal('carol');
const dave = userPrincipal('dave');
const erin = userPrincipal('erin');
const root = userPrincipal('root');

// d1, d2 under p1, d3 under p2 (both in o1), d4 under p3 (in o2).
const DOCS = [
  { id: 'd1', project_id: 'p1', org_id: 'o1' },
  { id: 'd2', project_id: 'p1', org_id: 'o1' },
  { id: 'd3', project_id: 'p2', org_id: 'o1' },
  { id: 'd4', project_id: 'p3', org_id: 'o2' },
];

/** What the last case's harness registered; cases run one at a time. */
let latest: { host: HostSetup; stores: DbHarnessStores } | undefined;
const remember = (host: HostSetup, stores: DbHarnessStores) => void (latest = { host, stores });
const stores = (): DbHarnessStores => {
  if (!latest) throw new Error('no case has registered its stores');
  return latest.stores;
};

const allowed: DecisionExpectation = { allowed: true };
const denied: DecisionExpectation = { allowed: false };
const check = (as: string, permission: Permission, resource: { type: string; id?: string }, expect: DecisionExpectation): Step => ({ check: { as, permission, resource }, expect });

// --- config roles + DB rows + the RbacModel, end to end ---------------------------------------

const e2eWorld: World = {
  now: NOW,
  permissions: ['doc:read', 'doc:write'].map((name) => ({ name, types: ['org', 'project', 'doc'] })),
  principals: { alice, bob, carol, dave, erin, root },
  scopes: [{ nodes: [{ ref: P1, parent: O1 }, { ref: P2, parent: O1 }, { ref: P3, parent: O2 }, { ref: O1 }, { ref: O2 }] }],
  // The adapter's parents answer the whole path of a doc, so they carry project → org too.
  adapters: [{ types: ['doc'], rows: { doc: DOCS.map((d) => ({ ...d })) }, parents: [...DOCS.map((d) => [doc(d.id), ref('project', d.project_id)] as const), [P1, O1] as const, [P2, O1] as const, [P3, O2] as const], compiles: [...CORE_FILTER_OPS, RBAC_ASSIGNMENT_OP] }],
  combine: combine('deny-overrides', 'rbac'),
  // Roles in the configuration's own shape: ConfigRoleStore reads authz.rbac.roles.
  config: { rbac: { roles: { viewer: { grants: ['doc:read'] }, editor: { extends: ['viewer'], grants: ['doc:write'] }, orgAdmin: { grants: ['doc:read', 'doc:write'], scopeTypes: ['org'] } } } },
  rbac: {
    assignments: [assignment('g1', root, 'viewer', GLOBAL), assignment('a1', alice, 'viewer', P1), assignment('b1', bob, 'editor', O1), assignment('c1', carol, 'orgAdmin', O2), assignment('c2', carol, 'viewer', doc('d1')), assignment('x1', dave, 'viewer', P2, { expiresAt: new Date(NOW.getTime() - HOUR) }), assignment('x2', dave, 'editor', P3, { expiresAt: new Date(NOW.getTime() + HOUR) }), assignment('e1', erin, 'orgAdmin', P1)],
  },
};

/** The SQL rows a type-level residual selects: native:rbac.assignment compiled by RbacOrmCompiler with the model's own args. */
async function sqlDocs(db: TestDb, model: RbacModel, host: HostSetup, residual: ResourceFilter): Promise<string[] | 'not native'> {
  if (residual.op === 'true') return DOCS.map((d) => d.id);
  if (residual.op === 'false') return [];
  // One query per native term, united: the same rows as OR inside one WHERE.
  if (residual.op === 'or') {
    const parts = await Promise.all(residual.args.map((r) => sqlDocs(db, model, host, r)));
    if (parts.includes('not native')) return 'not native';
    return [...new Set((parts as string[][]).flat())].sort();
  }
  if (residual.op !== RBAC_ASSIGNMENT_OP) return 'not native';
  const container = db.container.child();
  container.register(FixturePathSource).as(RbacScopePathSource);
  container.register(() => new RbacModelRoleGraphSource(model, [DocModel])).as(RbacRoleGraphSource);
  container.register(testHost.instance(host.kit.clock)).as(AuthzClock);
  const query = db.driver.select<Array<{ id: string }>>().from('doc').columns(['id']).orderBy('id');
  new RbacOrmCompiler(container).compile((residual as { args: unknown }).args, query, DocModel, alice);
  return ((await query) as unknown as Array<{ id: string }>).map((r) => String(r.id));
}

const parity = (dbOf: () => TestDb | undefined): Step => ({
  note: 'the native residual of each principal lists in SQL what the in-memory filter lists',
  do: async (ctx: StepContext) => {
    const model = stores().model!;
    let native = 0;
    for (const who of ['root', 'alice', 'bob', 'carol', 'dave', 'erin']) {
      const principal = ctx.principal(who);
      const residual = await ctx.session.authz!.filter!(principal, 'doc:read', 'doc');
      const inMemory = [...(await ctx.session.list!(principal, 'doc:read', 'doc'))].sort();
      const sql = await sqlDocs(dbOf()!, model, latest!.host, residual);
      expect(sql, `${who}: residual ${JSON.stringify(residual)}`).to.not.eq('not native');
      if (JSON.stringify(residual).includes(RBAC_ASSIGNMENT_OP)) native++;
      expect(sql, who).to.deep.eq(inMemory);
    }
    expect(native, 'principals whose residual is native:rbac.assignment').to.be.at.least(4);
    expect([...(await ctx.session.list!(ctx.principal('alice'), 'doc:read', 'doc'))].sort()).to.deep.eq(['d1', 'd2']);
    expect([...(await ctx.session.list!(ctx.principal('carol'), 'doc:read', 'doc'))].sort()).to.deep.eq(['d1', 'd4']);
  },
});

const e2eFixture = (dbOf: () => TestDb | undefined) =>
  extension('B06', [
    {
      name: 'l2-store-e2e',
      facets: ['engine', 'rbac', 'store', 'list'],
      lanes: ['L2'],
      note: 'ConfigRoleStore (roles in the configuration) and DbAssignmentStore rows under the RbacModel: checks at GLOBAL and at scopes, then the type-level residual through RbacOrmCompiler against the in-memory filter.',
      world: e2eWorld,
      cases: [
        {
          name: 'config roles and DB rows decide at GLOBAL and at scopes, and SQL lists what the filter lists',
          steps: [check('root', 'doc:read', GLOBAL, allowed), check('alice', 'doc:read', GLOBAL, denied), check('bob', 'doc:write', GLOBAL, denied), check('alice', 'doc:read', doc('d1'), allowed), check('alice', 'doc:read', doc('d3'), denied), check('alice', 'doc:write', doc('d1'), denied), check('bob', 'doc:write', doc('d3'), allowed), check('bob', 'doc:read', doc('d3'), allowed), check('bob', 'doc:write', doc('d4'), denied), check('carol', 'doc:write', doc('d4'), allowed), check('carol', 'doc:read', doc('d1'), allowed), check('carol', 'doc:read', doc('d2'), denied), check('dave', 'doc:read', doc('d3'), denied), check('dave', 'doc:read', doc('d4'), allowed), check('erin', 'doc:read', doc('d1'), denied), parity(dbOf)],
        },
      ],
    },
  ]);

// --- B12 store part: the warning L1 logs for a stored row of an unknown role ------------------

const warnings: string[] = [];
const ghostWorld: World = {
  permissions: ['doc:read'],
  principals: { alice, carol },
  combine: combine('deny-overrides', 'rbac'),
  rbac: { roles: [role('a', ['doc:read'])], assignments: [assignment('a1', alice, 'a')] },
};

const warningFixture = extension('B12', [
  {
    name: 'l2-store-warning',
    facets: ['engine', 'rbac', 'store'],
    lanes: ['L2'],
    note: 'B12.store says the warning is not observable through the kit and L2 asserts it: the RbacModel logs once per unknown role.',
    world: ghostWorld,
    cases: [
      {
        name: 'a stored row of an unknown role is ignored with one warning naming the row and the role',
        steps: [
          { note: 'no warning yet', do: () => void warnings.splice(0) },
          modelSteps.storedAssignment(assignment('g1', alice, 'ghost')),
          modelSteps.storedAssignment(assignment('g2', carol, 'ghost')),
          check('alice', 'doc:read', GLOBAL, allowed),
          check('carol', 'doc:read', GLOBAL, { allowed: false, reason: 'no_access' }),
          {
            note: 'one warning for the role',
            do: () => {
              const ghost = warnings.filter((w) => w.includes("unknown role 'ghost'"));
              expect(ghost, JSON.stringify(warnings)).to.have.length(1);
              expect(ghost[0]).to.match(/assignment 'g[12]' \(source: test\)/);
            },
          },
        ],
      },
    ],
  },
]);

// --- the CLI against the real AuthzAdmin and the DB stores ----------------------------------

const cliWorld: World = {
  permissions: ['file:edit', 'authz:assignments.manage'].map((name) => ({ name, types: ['org', 'project', 'file'] })),
  principals: { carol },
  scopes: [{ nodes: [{ ref: P1, parent: O1 }, { ref: O1 }] }],
  combine: combine('deny-overrides', 'rbac'),
  rbac: { roles: [role('editor', ['file:edit'])] },
};

async function cli(fn: () => Promise<void>): Promise<{ out: string[]; err: string[]; exitCode: number | undefined }> {
  const io = capture();
  try {
    await fn();
    return { out: [...io.out], err: [...io.err], exitCode: io.exitCode() };
  } finally {
    io.restore();
  }
}

const cliFixture = extension('B43', [
  {
    name: 'l2-store-cli',
    facets: ['engine', 'rbac', 'admin', 'store'],
    lanes: ['L2'],
    note: 'authz:assign and authz:revoke (task 9) through the real AuthzAdmin, DbAuthzAdminBackend and the DB stores.',
    world: cliWorld,
    cases: [
      {
        name: 'authz:assign then authz:revoke round-trip through AuthzAdmin and the DB stores',
        steps: [
          check('carol', 'file:edit', P1, denied),
          {
            note: 'assign, revoke by subject and role, assign, revoke by id',
            do: async (ctx) => {
              const service = ctx.session.authz as unknown as AuthzService;
              const assign = async (): Promise<string> => {
                const cmd = new AssignCommand();
                cmd.Authz = service;
                const run = await cli(() => cmd.execute('user:carol', 'editor', { scope: 'project:p1', tags: 'b,a' }));
                expect(run.err).to.deep.eq([]);
                expect(run.exitCode).to.eq(undefined);
                expect(run.out).to.have.length(1);
                return run.out[0];
              };
              const version = () => readVersion(activeDb().driver, 'test');
              const before = Number(await version());

              const id = await assign();
              const row = await stores().assignments.byId(id);
              expect(row).to.deep.include({ id, subject: { type: 'user', id: 'carol' }, role: 'editor', scope: P1, tags: ['a', 'b'], source: 'db' });
              expect(row!.grantedBy).to.deep.eq({ type: SYSTEM.type, id: SYSTEM.id });
              expect(Number(await version())).to.be.greaterThan(before);
              const allowedNow = await service.check({ principal: ctx.principal('carol'), permission: 'file:edit', resource: P1 });
              expect(allowedNow.allowed, 'carol may edit after authz:assign').to.eq(true);

              const revoke = new RevokeCommand();
              revoke.Authz = service;
              const byWhere = await cli(() => revoke.execute('user:carol', 'editor', { scope: 'project:p1' }));
              expect(byWhere).to.deep.eq({ out: ['1 assignment(s) revoked'], err: [], exitCode: undefined });
              expect(await stores().assignments.byId(id)).to.eq(null);

              const again = await assign();
              expect(again).to.not.eq(id);
              const byId = await cli(() => revoke.execute(undefined, undefined, { id: again }));
              expect(byId).to.deep.eq({ out: ['1 assignment revoked'], err: [], exitCode: undefined });
              expect((await stores().assignments.find({ at: NOW, includeExpired: true })).items).to.deep.eq([]);

              const none = await cli(() => revoke.execute('user:carol', 'editor', { scope: 'project:p1' }));
              expect(none.exitCode).to.eq(1);
              expect(none.err[0]).to.contain('0 revoked');
            },
          },
          check('carol', 'file:edit', P1, denied),
        ],
      },
    ],
  },
]);

// --------------------------------------------------------------------------------------------

for (const kind of DB_KINDS) {
  describe(`authz-rbac DB stores end to end (${kind})`, function () {
    this.timeout(120_000);

    let db: TestDb | undefined;
    const dbOf = () => db;

    before(async function () {
      db = await bootDb(this, kind, 'e2e');
      await db.driver.schema().createTable('doc', (t) => {
        t.string('id', 36).primaryKey().notNull();
        t.string('project_id', 36).notNull();
        t.string('org_id', 36).notNull();
      });
      for (const d of DOCS) await db.driver.insert().into('doc').values(d);
    });

    after(async () => {
      await db?.dispose();
    });

    runBehaviour(['B06.l2-store-e2e'], () => dbHarness(dbOf, { extensions: (_host, options) => [rbacAssignmentExtension(options)], register: remember }), { ...RUN, fixtures: [...BEHAVIOUR_FIXTURES, e2eFixture(dbOf)] });

    runBehaviour(['B12.l2-store-warning'], () => dbHarness(dbOf, { log: { warn: (m) => void warnings.push(m) } }), { ...RUN, fixtures: [...BEHAVIOUR_FIXTURES, warningFixture] });

    if (kind === 'sqlite') {
      runBehaviour(['B43.l2-store-cli'], () => dbHarness(dbOf, { admin: true, register: remember }), { ...RUN, fixtures: [...BEHAVIOUR_FIXTURES, cliFixture] });
    }
  });
}

// --- connections: authz.rbac.connection ?? authz.admin.connection ?? default ----------------

describe('authz-rbac DB stores and DbAuthzAdminBackend on one connection (sqlite)', function () {
  this.timeout(60_000);

  let db: TestDb;
  let configuration: Configuration;
  let other: string;
  const subject = { type: 'user', id: 'alice' };

  const rows = async (driver: OrmDriver) => ((await driver.select().from('authz_assignment')) as { id: string }[]).map((r) => r.id);
  const grant = async () => {
    const store = db.container.resolve(DbAssignmentStore);
    const backend = new DbAuthzAdminBackend({ container: db.container });
    return backend.transaction('root', (tx) => store.assign({ subject, role: 'editor', scope: GLOBAL }, SYSTEM, tx));
  };

  before(async function () {
    db = await bootDb(this, 'sqlite', 'connections', { second: true });
    // Stands in for an app step: @Migration('default') migrates only the default connection, so a
    // non-default authz.admin.connection or authz.rbac.connection needs these migrations run on it.
    await new AuthzRbac_2026_10_01_00_00_00().up(db.second!);
    await new AuthzAdminIdempotency_2026_10_02_00_01_00().up(db.second!);
    configuration = await db.container.resolve(Configuration);
    other = db.second!.Options.Name;
  });

  after(async () => {
    await db?.dispose();
  });

  beforeEach(async () => {
    for (const d of [db.driver, db.second!]) for (const t of ['authz_assignment', 'authz_version']) await rawQuery(d, `DELETE FROM ${t}`, [], QueryContext.Delete);
    configuration.set('authz.rbac.connection', undefined);
    configuration.set('authz.admin.connection', undefined);
  });

  it('with neither key, both use the default connection', async () => {
    const a = await grant();
    expect(await rows(db.driver)).to.deep.eq([a.id]);
    expect(await readVersion(db.driver, 'root')).to.eq('1');
    expect(await rows(db.second!)).to.deep.eq([]);
  });

  it('with only authz.admin.connection, the stores follow the backend to that connection', async () => {
    configuration.set('authz.admin.connection', other);

    const a = await grant();

    expect(await rows(db.second!)).to.deep.eq([a.id]);
    expect(await readVersion(db.second!, 'root')).to.eq('1');
    expect(await rows(db.driver)).to.deep.eq([]);
    expect(await db.container.resolve(DbAssignmentStore).byId(a.id)).to.deep.include({ id: a.id, role: 'editor' });
  });

  it('with both keys naming the same connection, both use it', async () => {
    configuration.set('authz.rbac.connection', other);
    configuration.set('authz.admin.connection', other);

    const a = await grant();

    expect(await rows(db.second!)).to.deep.eq([a.id]);
    expect(await rows(db.driver)).to.deep.eq([]);
  });

  it('with only authz.rbac.connection (not the default), the backend stays on the default and the first write is refused', async () => {
    configuration.set('authz.rbac.connection', other);

    await expect(grant()).to.be.rejectedWith(AuthzConfigError, /authz\.admin\.connection/);

    expect(await rows(db.second!)).to.deep.eq([]);
    expect(await rows(db.driver)).to.deep.eq([]);
  });
});
