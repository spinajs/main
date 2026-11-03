import { expect } from 'chai';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import 'mocha';

const run = promisify(execFile);

/** Script lines: `imports` and `register` come before the Configuration resolves, `seed` runs on the migrate-up run's Orm. */
interface ProcessSetup {
  readonly imports?: readonly string[];
  readonly register?: readonly string[];
  readonly seed?: readonly string[];
}

/**
 * A process that never resolved an Orm, as the cli is: imports the built package (`npm run compile` first), registers a
 * Configuration on a SQLite file and runs `body` against it. With `migrate`, a migrate-up run in a container of its
 * own creates the authz tables first, as a deploy step does before the cli runs.
 */
async function freshProcess(body: string, migrate = true, authz?: Record<string, unknown>, setup: ProcessSetup = {}): Promise<unknown> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spinajs-authz-cli-'));
  const script = [
    "import { DI } from '@spinajs/di';",
    "import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';",
    "import '@spinajs/log';",
    "import { Orm } from '@spinajs/orm';",
    "import { migrateTestDatabase } from '@spinajs/orm/testing';",
    "import { SqliteOrmDriver } from '@spinajs/orm-sqlite';",
    "import { AUTHZ_CONFIGURATION_SCHEMA, AuthzService, GLOBAL, SYSTEM } from '@spinajs/authz';",
    "import { AssignCommand, DbAssignmentStore, DbAuthzAdminBackend, ExplainCommand, VersionRecord, recordDriver } from '@spinajs/authz-rbac';",
    ...(setup.imports ?? []),
    'class Config extends FrameworkConfiguration {',
    '  async resolve() {',
    '    await super.resolve();',
    "    this.Config.db = { DefaultConnection: 'cli', Connections: [{ Name: 'cli', Driver: 'orm-driver-sqlite', Filename: process.env.AUTHZ_CLI_DB }], Aliases: { authz: 'default', 'authz-audit': 'default' } };",
    ...(authz ? [`    this.Config.authz = ${JSON.stringify(authz)};`] : []),
    '  }',
    '}',
    "DI.register(AUTHZ_CONFIGURATION_SCHEMA).asValue('__configurationSchema__');",
    'DI.register(Config).as(Configuration);',
    "DI.register(SqliteOrmDriver).as('orm-driver-sqlite');",
    ...(setup.register ?? []),
    'await DI.resolve(Configuration);',
    ...(migrate ? ['const { orm: tool } = await migrateTestDatabase(DI.child());', ...(setup.seed ?? []), 'await tool.dispose();'] : []),
    'const result = {};',
    'try {',
    body,
    '} catch (e) {',
    '  result.error = e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e);',
    '}',
    "console.log('RESULT ' + JSON.stringify(result));",
    'process.exit(0);',
  ].join('\n');

  try {
    const env = { ...process.env, AUTHZ_CLI_DB: path.join(dir, 'cli.sqlite') };
    const { stdout } = await run(process.execPath, ['--input-type=module', '-e', script], { cwd: process.cwd(), encoding: 'utf8', timeout: 60_000, env });
    const line = stdout.split(/\r?\n/).find((l) => l.startsWith('RESULT '));
    expect(line, stdout).to.be.a('string');
    return JSON.parse(line!.slice('RESULT '.length));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('authz-rbac DB stores and DbAuthzAdminBackend in a process that has not resolved the Orm', function () {
  this.timeout(120_000);

  it('recordDriver says the Orm is not resolved, not that the authz alias is missing', async () => {
    const result = await freshProcess(['try { recordDriver(VersionRecord); } catch (e) { result.message = `${e.constructor.name}: ${e.message}`; }'].join('\n'), false);
    expect(result).to.deep.eq({ message: 'AuthzConfigError: VersionRecord: the Orm is not resolved yet; resolve it (await DI.resolve(Orm)) before the authz tables are used' });
  });

  it('resolving a store on a database migrate-up never ran on refuses and names migrate-up', async () => {
    const result = (await freshProcess('await DI.resolve(DbAssignmentStore);', false)) as { error?: string };
    expect(result.error).to.match(/^PendingMigrationsException: .*npx spinajs migrate-up/);
  });

  it('resolving a store resolves the Orm', async () => {
    const result = await freshProcess(
      [
        'const store = await DI.resolve(DbAssignmentStore);',
        'result.orm = DI.get(Orm) !== undefined;',
        'result.found = (await store.find({ at: new Date(), includeExpired: true })).total;',
      ].join('\n'),
    );
    expect(result).to.deep.eq({ orm: true, found: 0 });
  });

  it('a DbAuthzAdminBackend batch runs on the Orm the backend resolved, and the store reads what it wrote', async () => {
    const result = await freshProcess(
      [
        'const backend = await DI.resolve(DbAuthzAdminBackend);',
        'result.orm = DI.get(Orm) !== undefined;',
        'const store = await DI.resolve(DbAssignmentStore);',
        "const a = await backend.transaction('root', (tx) => store.assign({ subject: { type: 'user', id: 'alice' }, role: 'editor', scope: GLOBAL }, SYSTEM, tx));",
        'result.role = (await store.byId(a.id))?.role;',
      ].join('\n'),
    );
    expect(result).to.deep.eq({ orm: true, role: 'editor' });
  });

  it('resolving DbAuthzAdminBackend resolves the Orm', async () => {
    const result = await freshProcess(
      [
        'const backend = await DI.resolve(DbAuthzAdminBackend);',
        'result.orm = DI.get(Orm) !== undefined;',
        "result.recalled = (await backend.recall('root', 'system:system', 'k1', new Date())) ?? null;",
      ].join('\n'),
    );
    expect(result).to.deep.eq({ orm: true, recalled: null });
  });
});

/** RBAC on the DB assignment store, with the permissions AuthzAdmin checks for an assignment. */
const DB_AUTHZ = {
  permissions: { 'doc:read': {}, 'authz:assignments.manage': {}, 'users:update': {} },
  models: ['RbacModel'],
  admin: { backend: 'DbAuthzAdminBackend', guard: { service: 'DefaultAdminGuard', privilegedPermission: 'users:update' } },
  rbac: { roles: { viewer: { grants: ['doc:read'] } }, stores: { roles: ['ConfigRoleStore'], assignments: ['DbAssignmentStore'], rules: [], links: [], membership: [] } },
};

/** Runs the cli commands in `body` and keeps what they print; the log lines (colored) are left out. */
const cliRun = (body: string[]): string =>
  [
    'const lines = [];',
    'const log = console.log;',
    'const error = console.error;',
    "console.log = (...a) => lines.push(a.join(' '));",
    "console.error = (...a) => lines.push('error: ' + a.join(' '));",
    'try {',
    ...body,
    '} finally {',
    '  console.log = log;',
    '  console.error = error;',
    '}',
    "result.out = lines.filter((l) => !l.includes('\\u001b['));",
    'result.exitCode = process.exitCode ?? null;',
    'result.orm = DI.get(Orm) !== undefined;',
  ].join('\n');

describe('authz-rbac AuthzService and the authz cli in a process that has not resolved the Orm', function () {
  this.timeout(120_000);

  it('resolving AuthzService over the DB stores resolves the Orm, and the stores it boots write and read', async () => {
    const result = await freshProcess(
      [
        'const authz = await DI.resolve(AuthzService);',
        'result.orm = DI.get(Orm) !== undefined;',
        "await authz.runAs(SYSTEM, 'test', () => authz.admin().assign(SYSTEM, { subject: { type: 'user', id: 'alice' }, role: 'viewer', scope: GLOBAL }));",
        "const principal = { type: 'user', id: 'alice', authenticated: true, source: 'test', attributes: {} };",
        "result.allowed = (await authz.explain({ principal, permission: 'doc:read', resource: GLOBAL })).allowed;",
      ].join('\n'),
      true,
      DB_AUTHZ,
    );
    expect(result).to.deep.eq({ orm: true, allowed: true });
  });

  it('resolving AuthzService over the DB stores on a database migrate-up never ran on refuses with PendingMigrationsException as the cause', async () => {
    const result = await freshProcess('try { await DI.resolve(AuthzService); } catch (e) { result.cause = e.cause?.constructor.name; throw e; }', false, DB_AUTHZ);
    expect(result).to.have.property('cause', 'PendingMigrationsException');
    expect((result as { error: string }).error).to.match(/^AuthzConfigError: .*npx spinajs migrate-up/);
  });

  it('authz:assign and authz:explain resolve only AuthzService; the DB stores it boots bring the Orm up', async () => {
    const result = (await freshProcess(cliRun(["await (await DI.resolve(AssignCommand)).execute('user:alice', 'viewer', {});", "await (await DI.resolve(ExplainCommand)).execute('user:alice', 'doc:read', undefined, {});"]), true, DB_AUTHZ)) as { out: string[]; exitCode: number | null; orm: boolean };
    expect(result.out[0]).to.match(/^[0-9a-f-]{36}$/);
    expect(result.out[1]).to.eq('ALLOWED: user:alice doc:read on $global');
    expect(result).to.include({ exitCode: null, orm: true });
  });

  it('authz:explain on a database migrate-up never ran on prints the refusal, naming migrate-up, and exits 1', async () => {
    const result = (await freshProcess(cliRun(["await (await DI.resolve(ExplainCommand)).execute('user:alice', 'doc:read', undefined, {});"]), false, DB_AUTHZ)) as { out: string[]; exitCode: number | null };
    expect(result.out).to.have.length(1);
    expect(result.out[0]).to.match(/^error: Authz domain "root": model "rbac" failed to init: Database is not migrated: .*npx spinajs migrate-up/);
    expect(result.exitCode).to.eq(1);
  });
});

/** ReBAC on its DB tuple store and ABAC on its DB policy store, no RBAC model, and DbDecisionAudit as the audit. */
const REBAC_ABAC_AUTHZ = {
  permissions: { 'doc:read': {} },
  models: ['AppRebacModel', 'AbacModel'],
  rebac: { store: 'DbTupleStore', permissions: { 'doc:read': 'doc#view' }, namespaces: { doc: { relations: { viewer: ['user'] }, permissions: { view: { union: ['viewer'] } } } } },
  abac: { stores: ['DbPolicyStore'] },
};

const REBAC_ABAC_SETUP: ProcessSetup = {
  imports: ["import { AuthorizationModel, DecisionAudit } from '@spinajs/authz';", "import { DbTupleStore, RebacModel } from '@spinajs/authz-rebac';", "import '@spinajs/authz-abac';", "import { AuthzAuditEntry, DbDecisionAudit } from '@spinajs/authz-orm/audit';"],
  register: ['const rebac = new RebacModel();', "DI.register(Object.defineProperty(() => rebac, 'name', { value: 'AppRebacModel' })).as(AuthorizationModel);", 'DI.register(DbDecisionAudit).as(DecisionAudit);'],
  seed: ["await new DbTupleStore().write([{ object: { type: 'doc', id: 'd1' }, relation: 'viewer', subject: { type: 'user', id: 'alice' } }], [], SYSTEM);"],
};

describe('the authz cli over ReBAC and ABAC DB stores in a process that has not resolved the Orm', function () {
  this.timeout(120_000);

  it('authz:explain reads the tuple and the policies through the Orm the models boot, and the audit rows are written', async () => {
    const body = cliRun([
      "await (await DI.resolve(ExplainCommand)).execute('user:alice', 'doc:read', 'doc:d1', {});",
      // DbDecisionAudit.record is fire and forget.
      'for (let i = 0; i < 100 && (await AuthzAuditEntry.all()).length < 2; i++) await new Promise((r) => setTimeout(r, 20));',
      'result.audit = (await AuthzAuditEntry.all()).map((e) => e.kind).sort();',
    ]);
    const result = (await freshProcess(body, true, REBAC_ABAC_AUTHZ, REBAC_ABAC_SETUP)) as { out: string[]; exitCode: number | null; orm: boolean; audit: string[]; error?: string };
    expect(result.error).to.eq(undefined);
    expect(result.out[0]).to.eq('ALLOWED: user:alice doc:read on doc:d1');
    expect(result).to.include({ exitCode: null, orm: true });
    expect(result.audit).to.include.members(['explain', 'runAs']);
  });

  it('with memory RBAC stores only, DbDecisionAudit boots the Orm and writes the audit rows of authz:explain', async () => {
    const authz = { permissions: { 'doc:read': {} }, models: ['RbacModel'], rbac: { roles: { viewer: { grants: ['doc:read'] } }, stores: { assignments: ['MemoryAdminAssignmentStore'], links: [], membership: [] } } };
    const setup: ProcessSetup = {
      imports: ["import { DecisionAudit } from '@spinajs/authz';", "import { MemoryAdminAssignmentStore } from '@spinajs/authz-rbac';", "import { AuthzAuditEntry, DbDecisionAudit } from '@spinajs/authz-orm/audit';"],
      register: ['DI.register(MemoryAdminAssignmentStore).asSelf();', 'DI.register(DbDecisionAudit).as(DecisionAudit);'],
    };
    const body = cliRun([
      "await (await DI.resolve(ExplainCommand)).execute('user:alice', 'doc:read', undefined, {});",
      'for (let i = 0; i < 100 && (await AuthzAuditEntry.all()).length < 2; i++) await new Promise((r) => setTimeout(r, 20));',
      'result.audit = (await AuthzAuditEntry.all()).map((e) => e.kind).sort();',
    ]);
    const result = (await freshProcess(body, true, authz, setup)) as { out: string[]; orm: boolean; audit: string[]; error?: string };
    expect(result.error).to.eq(undefined);
    expect(result.out[0]).to.eq('DENIED: user:alice doc:read on $global');
    expect(result.orm).to.eq(true);
    expect(result.audit).to.include.members(['explain', 'runAs']);
  });

  it('an ABAC-only domain on DbPolicyStore boots the Orm and explains', async () => {
    const authz = { permissions: { 'doc:read': {} }, models: ['AbacModel'], abac: { stores: ['DbPolicyStore'] } };
    const result = (await freshProcess(cliRun(["await (await DI.resolve(ExplainCommand)).execute('user:alice', 'doc:read', 'doc:d1', {});"]), true, authz, { imports: ["import '@spinajs/authz-abac';"] })) as { out: string[]; exitCode: number | null; orm: boolean };
    expect(result.out[0]).to.eq('DENIED: user:alice doc:read on doc:d1');
    expect(result).to.include({ exitCode: null, orm: true });
  });
});
