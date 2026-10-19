import { expect } from 'chai';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import 'mocha';

const run = promisify(execFile);

/**
 * A process that never resolved an Orm, as the cli is: imports the built package (`npm run compile` first), registers a
 * Configuration on SQLite `:memory:` with the authz tables there, and runs `body` against it.
 */
async function freshProcess(body: string): Promise<unknown> {
  const script = [
    "import { DI } from '@spinajs/di';",
    "import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';",
    "import '@spinajs/log';",
    "import { SqliteOrmDriver } from '@spinajs/orm-sqlite';",
    "import { AUTHZ_CONFIGURATION_SCHEMA, GLOBAL, SYSTEM } from '@spinajs/authz';",
    "import { DbAssignmentStore, DbAuthzAdminBackend, VersionRecord, recordDriver } from '@spinajs/authz-rbac';",
    'const { ofType, chainOf } = Array;',
    'class Config extends FrameworkConfiguration {',
    '  async resolve() {',
    '    await super.resolve();',
    "    this.Config.db = { DefaultConnection: 'cli', Connections: [{ Name: 'cli', Driver: 'orm-driver-sqlite', Filename: ':memory:', Migration: { OnStartup: true } }], Aliases: { authz: 'default' } };",
    '  }',
    '}',
    "DI.register(AUTHZ_CONFIGURATION_SCHEMA).asValue('__configurationSchema__');",
    'DI.register(Config).as(Configuration);',
    "DI.register(SqliteOrmDriver).as('orm-driver-sqlite');",
    'await DI.resolve(Configuration);',
    'Object.assign(Array, { ofType, chainOf });',
    'const result = {};',
    'try {',
    body,
    '} catch (e) {',
    '  result.error = e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e);',
    '}',
    "console.log('RESULT ' + JSON.stringify(result));",
    'process.exit(0);',
  ].join('\n');

  const { stdout } = await run(process.execPath, ['--input-type=module', '-e', script], { cwd: process.cwd(), encoding: 'utf8', timeout: 60_000 });
  const line = stdout.split(/\r?\n/).find((l) => l.startsWith('RESULT '));
  expect(line, stdout).to.be.a('string');
  return JSON.parse(line!.slice('RESULT '.length));
}

describe('authz-rbac DB stores and DbAuthzAdminBackend in a process that has not resolved the Orm', function () {
  this.timeout(120_000);

  it('recordDriver says the Orm is not resolved, not that the authz alias is missing', async () => {
    const result = await freshProcess(['try { recordDriver(VersionRecord); } catch (e) { result.message = `${e.constructor.name}: ${e.message}`; }'].join('\n'));
    expect(result).to.deep.eq({ message: 'AuthzConfigError: VersionRecord: the Orm is not resolved yet; resolve it (await DI.resolve(Orm)) before the authz tables are used' });
  });

  it('a store read resolves the Orm first', async () => {
    const result = await freshProcess(["const store = DI.resolve(DbAssignmentStore);", "result.found = (await store.find({ at: new Date(), includeExpired: true })).total;"].join('\n'));
    expect(result).to.deep.eq({ found: 0 });
  });

  it('a DbAuthzAdminBackend batch resolves the Orm first, and the store reads what it wrote', async () => {
    const result = await freshProcess(
      [
        'const store = DI.resolve(DbAssignmentStore);',
        "const a = await new DbAuthzAdminBackend().transaction('root', (tx) => store.assign({ subject: { type: 'user', id: 'alice' }, role: 'editor', scope: GLOBAL }, SYSTEM, tx));",
        'result.role = (await store.byId(a.id))?.role;',
      ].join('\n'),
    );
    expect(result).to.deep.eq({ role: 'editor' });
  });

  it('DbAuthzAdminBackend.recall resolves the Orm first', async () => {
    const result = await freshProcess(["result.recalled = (await new DbAuthzAdminBackend().recall('root', 'system:system', 'k1', new Date())) ?? null;"].join('\n'));
    expect(result).to.deep.eq({ recalled: null });
  });
});
