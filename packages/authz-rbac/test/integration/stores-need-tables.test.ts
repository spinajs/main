import { expect } from 'chai';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import 'mocha';

const run = promisify(execFile);

/** Roles from config only, `service:lan` holds `viewer`; `rbac.stores` is merged in per case. */
function authzConfig(stores?: Record<string, string[]>): Record<string, unknown> {
  return { permissions: { 'doc:read': {} }, models: ['RbacModel'], rbac: { roles: { viewer: { grants: ['doc:read'] } }, serviceRoles: { 'service:lan': ['viewer'] }, ...(stores ? { stores } : {}) } };
}

interface Case {
  /** `db` config of the process, on a SQLite file. */
  readonly db: Record<string, unknown>;
  readonly authz: Record<string, unknown>;
  readonly register?: readonly string[];
  readonly body: string;
}

/**
 * A process as the app runs it, on the built package (`npm run compile` first): a Configuration with `db` and
 * `authz`, the SQLite driver, then `body`. `result` collects what the body reports; a throw lands in `result.error`.
 */
async function processRun(c: Case): Promise<Record<string, unknown>> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spinajs-authz-tables-'));
  const script = [
    "import { DI } from '@spinajs/di';",
    "import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';",
    "import '@spinajs/log';",
    "import { resolveMigrationTool } from '@spinajs/orm';",
    "import { SqliteOrmDriver } from '@spinajs/orm-sqlite';",
    "import { AUTHZ_CONFIGURATION_SCHEMA, AuthzService, GLOBAL } from '@spinajs/authz';",
    "import { MemoryAdminAssignmentStore, MemoryLinkStore } from '@spinajs/authz-rbac';",
    'class Config extends FrameworkConfiguration {',
    '  async resolve() {',
    '    await super.resolve();',
    `    this.Config.db = { DefaultConnection: 'app', Connections: [{ Name: 'app', Driver: 'orm-driver-sqlite', Filename: process.env.AUTHZ_TABLES_DB }], ...${JSON.stringify(c.db)} };`,
    `    this.Config.authz = ${JSON.stringify(c.authz)};`,
    '  }',
    '}',
    "DI.register(AUTHZ_CONFIGURATION_SCHEMA).asValue('__configurationSchema__');",
    'DI.register(Config).as(Configuration);',
    "DI.register(SqliteOrmDriver).as('orm-driver-sqlite');",
    ...(c.register ?? []),
    'await DI.resolve(Configuration);',
    "const lan = { type: 'service', id: 'lan', authenticated: true, source: 'test', attributes: {} };",
    'const result = {};',
    'try {',
    c.body,
    '} catch (e) {',
    '  result.error = e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e);',
    '}',
    "console.log('RESULT ' + JSON.stringify(result));",
    'process.exit(0);',
  ].join('\n');

  try {
    const env = { ...process.env, AUTHZ_TABLES_DB: path.join(dir, 'app.sqlite') };
    const { stdout } = await run(process.execPath, ['--input-type=module', '-e', script], { cwd: process.cwd(), encoding: 'utf8', timeout: 60_000, env });
    const line = stdout.split(/\r?\n/).find((l) => l.startsWith('RESULT '));
    expect(line, stdout).to.be.a('string');
    return JSON.parse(line!.slice('RESULT '.length)) as Record<string, unknown>;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const BOOT_AND_CHECK = ['const authz = await DI.resolve(AuthzService);', "const decision = await authz.explain({ principal: lan, permission: 'doc:read', resource: GLOBAL });", 'result.allowed = decision.allowed;'].join('\n');

describe('authz-rbac database stores without their tables', function () {
  this.timeout(120_000);

  it('the default stores with no connection behind db.Aliases.authz refuse the boot, naming the store, the alias and the in-memory stores', async () => {
    const result = await processRun({ db: { Aliases: { authz: 'nowhere' } }, authz: authzConfig(), body: BOOT_AND_CHECK });
    expect(result).to.not.have.property('allowed');
    expect(result.error).to.be.a('string');
    const error = result.error as string;
    expect(error).to.match(/^AuthzConfigError: /);
    expect(error).to.include('DbAssignmentStore (authz.rbac.stores.assignments): AssignmentRecord: no ORM connection answers to "authz"; set db.Aliases.authz');
    expect(error).to.include('DbLinkStore (authz.rbac.stores.links)');
    expect(error).to.include("authz.rbac.stores.assignments: ['MemoryAdminAssignmentStore']");
  });

  it('the default stores on a connection without the authz tables refuse the boot, naming the table and its migration', async () => {
    const result = await processRun({ db: { Aliases: { authz: 'app' }, MigrationCheck: 'off', StrictTableCheck: false }, authz: authzConfig(), body: BOOT_AND_CHECK });
    expect(result).to.not.have.property('allowed');
    expect(result.error).to.be.a('string');
    expect(result.error).to.include('DbAssignmentStore (authz.rbac.stores.assignments): table authz_assignment on connection "app" does not exist; migration AuthzRbac_2026_10_01_00_00_00 of @spinajs/authz-rbac creates it (npx spinajs migrate-up)');
  });

  it('migrate-up on an empty database completes with the default stores, and a boot refused before it succeeds after it', async () => {
    const result = await processRun({
      db: { Aliases: { authz: 'app' } },
      authz: authzConfig(),
      body: [
        'const migrator = await resolveMigrationTool();',
        // A process without an http server may boot authz while migrate-up runs (configuration-db-source does after 15 s).
        "try { await DI.resolve(AuthzService); } catch (e) { result.early = e.message.includes('table authz_assignment'); }",
        'result.applied = (await migrator.migrate()).map((m) => m.constructor.name);',
        BOOT_AND_CHECK,
      ].join('\n'),
    });
    expect(result.error).to.eq(undefined);
    expect(result.early).to.eq(true);
    expect(result.applied).to.include('AuthzRbac_2026_10_01_00_00_00');
    expect(result.allowed).to.eq(true);
  });

  it('roles from config with the in-memory stores boot with no connection behind db.Aliases.authz and answer checks', async () => {
    const result = await processRun({
      db: { Aliases: { authz: 'nowhere' } },
      authz: authzConfig({ assignments: ['MemoryAdminAssignmentStore'], links: ['MemoryLinkStore'] }),
      register: ['DI.register(MemoryAdminAssignmentStore).asSelf();', 'DI.register(MemoryLinkStore).asSelf();'],
      body: BOOT_AND_CHECK,
    });
    expect(result).to.deep.eq({ allowed: true });
  });
});
