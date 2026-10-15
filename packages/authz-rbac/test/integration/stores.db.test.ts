import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';

import { AuthzConfigError, GLOBAL, SYSTEM } from '@spinajs/authz';
import type { AuthzService, Permission } from '@spinajs/authz';
import { BEHAVIOUR_FIXTURES, fixtureDsl, modelSteps, runBehaviour, userPrincipal } from '@spinajs/authz-testing';
import type { DecisionExpectation, HostSetup, Step, World } from '@spinajs/authz-testing';
import { Configuration } from '@spinajs/configuration';
import { QueryContext } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';

import { AssignCommand, RevokeCommand } from '../../src/cli/index.js';
import { AuthzAdminIdempotency_2026_10_02_00_01_00, AuthzRbac_2026_10_01_00_00_00, DbAssignmentStore, DbAuthzAdminBackend, readVersion } from '../../src/index.js';
import { capture } from '../cli/fixture.js';
import { bootDb, DB_KINDS, rawQuery } from '../support/db.js';
import type { TestDb } from '../support/db.js';
import { activeDb, dbHarness } from './db-harness.js';
import type { DbHarnessStores } from './db-harness.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

const { assignment, combine, extension, ref, role } = fixtureDsl;
const RUN = { strict: true, timeoutMs: 60_000 };

const NOW = new Date('2026-10-01T12:00:00.000Z');
const O1 = ref('org', 'o1');
const P1 = ref('project', 'p1');

const alice = userPrincipal('alice');
const carol = userPrincipal('carol');

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
    });

    after(async () => {
      await db?.dispose();
    });

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
    configuration.set('authz.admin.connection', 'default');
  });

  it('with neither key named by the app, both use the default connection (the schema default of authz.admin.connection)', async () => {
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
